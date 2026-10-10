import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Synthetic INSERT-only migration fixtures exercise reads. Normal write APIs do
// not accept these malformed dates, and no immutable version row is rewritten.
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const password = 'synthetic-month-filter-safety-password';
const ids = items => items.map(item => item.id).sort();

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extra = {}) {
    const headers = { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
    const response = await fetch(base + url, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成月份管理者', email: 'admin@month-filter.example.test', password, organizationName: '合成月份甲機構' });
  assert.equal(setup.status, 201);
  const from = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken,
    org: setup.body.organizations[0].id, user: response.body.user });
  const admin = from(setup), clients = { admin };
  async function create(entity, data, client = admin, extra = {}) {
    const result = await request(client, 'POST', '/api/' + entity, data, extra);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成月份居服甲', employeeNo: 'MF-EA', role: 'caregiver', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成月份居服乙', employeeNo: 'MF-EB', role: 'caregiver', hourlyRateCents: 26000 });
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA]]) {
    const email = key + '@month-filter.example.test';
    await create('users', { name: '合成月份' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = from(login);
  }
  const caseA = await create('cases', { name: '合成月份個案甲', caseNo: 'MF-CA' });
  const caseB = await create('cases', { name: '合成月份個案乙', caseNo: 'MF-CB' });
  const service = await create('service-items', { code: 'MF-SERVICE', name: '合成月份服務', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: structuredClone(services) });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = extra => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08',
    startTime: '09:00', endTime: '10:00', services: structuredClone(services), status: 'scheduled', note: '合成月份交班', ...extra });
  const shiftA = await create('shifts', shiftData()), shiftB = await create('shifts', shiftData({ caseId: caseB.id, employeeId: employeeB.id, carePlanId: planB.id }));
  const organizationB = await create('organizations', { name: '合成月份乙機構' }), foreignAdmin = { ...admin, org: organizationB.id };
  const foreignEmployee = await create('employees', { name: '合成外機構居服', employeeNo: 'MF-FE' }, foreignAdmin);
  const foreignCase = await create('cases', { name: '合成外機構個案', caseNo: 'MF-FC' }, foreignAdmin);
  const foreignService = await create('service-items', { code: 'MF-FS', name: '合成外機構服務', minutes: 60, unitPriceCents: 0 }, foreignAdmin);
  const foreignPlan = await create('care-plans', { ...planData(foreignCase.id), services: [{ serviceItemId: foreignService.id, quantity: 1 }] }, foreignAdmin);
  const foreignShift = await create('shifts', { ...shiftData(), caseId: foreignCase.id, employeeId: foreignEmployee.id, carePlanId: foreignPlan.id,
    services: [{ serviceItemId: foreignService.id, quantity: 1 }] }, foreignAdmin);
  const recordData = (shift = shiftA, extra = {}) => ({ shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date,
    actualStart: '09:00', actualEnd: '10:00', services: structuredClone(shift.services), status: 'draft', note: '合成月份紀錄', ...extra });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() });
  assert.deepEqual(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), tables.slice().sort());
  assert.equal(state().triggers.length, 6);
  async function unchanged(fn) { const before = state(); try { return await fn(); } finally { assert.deepEqual(state(), before, 'Entire eleven-table read/rejection batch must leave raw rows, versions, BLOBs, triggers and total_changes unchanged'); } }
  function imported(entity, data, org = admin.org) {
    const item = insert(app.db, org, entity, structuredClone(data));
    const raw = app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id);
    const versions = app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(item.id);
    assert.equal(raw.org_id, org); assert.equal(raw.entity, entity); assert.equal(raw.version, 1); assert.deepEqual(JSON.parse(raw.data), data);
    assert.equal(versions.length, 1); assert.equal(versions[0].source, 'create'); assert.deepEqual(JSON.parse(versions[0].snapshot), item);
    return item;
  }
  async function list(entity, query = '', client = admin) {
    const result = await request(client, 'GET', '/api/' + entity + '?pageSize=100' + (query ? '&' + query : ''));
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  return { app, request, create, admin, clients, employeeA, employeeB, caseA, caseB, service, services, planA, planB, planData,
    shiftA, shiftB, shiftData, foreignAdmin, foreignCase, foreignEmployee, foreignShift, recordData, state, unchanged, imported, list };
}

test('typed imported shift dates no longer break month lists while unfiltered items and immutable history retain exact JSON', async t => {
  const f = await fixture(t), values = [123, { imported: '2026-10-09' }, ['2026-10-09'], true, [], {}, 0, false, null, ''];
  const imported = values.map((date, i) => f.imported('shifts', f.shiftData({ date, note: 'MF-TYPED-' + i })));
  const missingData = f.shiftData({ note: 'MF-MISSING' }); delete missingData.date;
  imported.push(f.imported('shifts', missingData));
  await f.unchanged(async () => {
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10')).items), ids([f.shiftA, f.shiftB]));
    assert.deepEqual(ids((await f.list('shifts')).items), ids([f.shiftA, f.shiftB, ...imported]));
    for (const item of imported) {
      const current = await f.request(f.admin, 'GET', '/api/shifts/' + item.id);
      assert.equal(current.status, 200); assert.deepEqual(current.body.item, item);
      const history = await f.request(f.admin, 'GET', '/api/shifts/' + item.id + '/history?compare=previous');
      assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.deepEqual(history.body.items[0].snapshot, item);
      assert.equal(history.body.items[0].comparison.status, 'initial'); assert.equal(history.body.items[0].actor, null);
    }
  });
});

test('date remains the selected truthy value; only falsy date values use validFrom and a nonstring fallback is excluded', async t => {
  const f = await fixture(t), cases = [
    { name: 'date-wins', date: '2026-10-12', validFrom: '2026-09-01', include: true },
    { name: 'other-date-wins', date: '2026-09-12', validFrom: '2026-10-01', include: false },
    ...[{ imported: 'PRIVATE' }, ['2026-10-01'], true, 20261001, [], {}].map((date, i) => ({ name: 'truthy-' + i, date, validFrom: '2026-10-01', include: false })),
    ...[null, '', 0, false].map((date, i) => ({ name: 'falsy-' + i, date, validFrom: '2026-10-01', include: true })),
    { name: 'absent-date', validFrom: '2026-10-01', include: true },
    ...[{ imported: 'PRIVATE' }, ['2026-10-01'], true, 20261001, null, '', 0, false].map((validFrom, i) => ({ name: 'fallback-' + i, date: null, validFrom, include: false })),
    { name: 'both-absent', include: false },
  ];
  const rows = cases.map(row => {
    const data = f.planData(f.caseA.id); delete data.validFrom;
    if (Object.hasOwn(row, 'date')) data.date = row.date;
    if (Object.hasOwn(row, 'validFrom')) data.validFrom = row.validFrom;
    data.note = 'MF-FALLBACK-' + row.name; return { item: f.imported('care-plans', data), include: row.include };
  });
  await f.unchanged(async () => {
    const result = await f.list('care-plans', 'month=2026-10');
    assert.deepEqual(ids(result.items), ids(rows.filter(row => row.include).map(row => row.item)));
    assert.equal(result.total, 6);
    const unfiltered = await f.list('care-plans'); assert.equal(unfiltered.total, rows.length + 2);
    for (const row of rows) assert.deepEqual(unfiltered.items.find(item => item.id === row.item.id), row.item);
  });
});

test('month matching preserves original raw string prefix behavior without trimming parsing or repairing imported dates', async t => {
  const f = await fixture(t), cases = [
    ['2026-10-invalid', true], ['2026-10', true], ['2026-10-99', true], ['2026-1001', true],
    ['2026-10-09T23:59:00-04:00', true], ['2026-10-09 ', true], ['2026-10\nPRIVATE', true],
    [' 2026-10-09', false], ['\n2026-10-09', false], ['2026-1-09', false], ['2026-11-01', false], ['0000-02-29', false],
  ];
  const rows = cases.map(([date, include], i) => ({ item: f.imported('shifts', f.shiftData({ date, note: 'MF-PREFIX-' + i })), include }));
  await f.unchanged(async () => {
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10')).items), ids([f.shiftA, f.shiftB, ...rows.filter(row => row.include).map(row => row.item)]));
    assert.deepEqual(ids((await f.list('shifts', 'month=0000-02')).items), ids([rows.at(-1).item]));
    for (const row of rows) assert.deepEqual((await f.request(f.admin, 'GET', '/api/shifts/' + row.item.id)).body.item, row.item);
  });
});

test('status date case employee and q filters compose with safe month selection and totals precede unchanged pagination', async t => {
  const f = await fixture(t), expected = [];
  for (let i = 0; i < 3; i++) expected.push(f.imported('shifts', f.shiftData({ date: '2026-10-21', status: 'cancelled', note: 'MiXeD-MF-TARGET-' + i })));
  f.imported('shifts', f.shiftData({ date: { imported: 'PRIVATE' }, status: 'cancelled', note: 'MiXeD-MF-TARGET-malformed' }));
  f.imported('shifts', f.shiftData({ date: '2026-10-21', status: 'scheduled', note: 'MiXeD-MF-TARGET-status' }));
  f.imported('shifts', f.shiftData({ date: '2026-10-21', status: 'cancelled', caseId: f.caseB.id, carePlanId: f.planB.id, note: 'MiXeD-MF-TARGET-case' }));
  f.imported('shifts', f.shiftData({ date: '2026-10-21', status: 'cancelled', employeeId: f.employeeB.id, note: 'MiXeD-MF-TARGET-employee' }));
  f.imported('shifts', f.shiftData({ date: '2026-09-21', status: 'cancelled', note: 'MiXeD-MF-TARGET-month' }));
  const boundedSearch = f.imported('shifts', f.shiftData({ date: '2026-10-30', note: 'Q'.repeat(200) }));
  const query = 'status=cancelled&date=2026-10-21&caseId=' + f.caseA.id + '&employeeId=' + f.employeeA.id + '&month=2026-10&q=mixed-mf-target';
  await f.unchanged(async () => {
    const full = await f.list('shifts', query); assert.equal(full.total, 3); assert.deepEqual(ids(full.items), ids(expected));
    const page = await f.request(f.admin, 'GET', '/api/shifts?' + query + '&page=2&pageSize=1');
    assert.equal(page.status, 200); assert.equal(page.body.total, 3); assert.equal(page.body.page, 2); assert.equal(page.body.pageSize, 1); assert.deepEqual(page.body.items, [full.items[1]]);
    const beyond = await f.request(f.admin, 'GET', '/api/shifts?' + query + '&page=4&pageSize=1'); assert.equal(beyond.status, 200); assert.equal(beyond.body.total, 3); assert.deepEqual(beyond.body.items, []);
    assert.equal((await f.list('shifts', query + '&q=NO-MATCH')).total, 3, 'Duplicate q continues to use the first value');
    assert.equal((await f.list('shifts', query.replace('q=mixed-mf-target', 'q=%20mixed-mf-target'))).total, 0, 'Search is not silently trimmed');
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10&q=' + 'Q'.repeat(201))).items), ids([boundedSearch]), 'Search still consumes only the first 200 characters');
    for (const filter of ['status=missing', 'date=2026-11-01', 'caseId=unknown', 'employeeId=unknown']) assert.equal((await f.list('shifts', filter + '&month=2026-10')).total, 0);
  });
});

test('service record month reads preserve four-role projections and caregiver ownership across every original record status', async t => {
  const f = await fixture(t), own = ['draft', 'submitted', 'approved', 'returned'].map((status, i) => f.imported('service-records', f.recordData(f.shiftA, { date: '2026-10-' + (10 + i), status,
    billingSnapshot: { syntheticMarker: 'PRIVATE-BILLING-' + i }, note: 'MF-OWN-' + i })));
  const other = f.imported('service-records', f.recordData(f.shiftB, { date: '2026-10-20', status: 'draft' }));
  const bad = [{ imported: '2026-10-10' }, ['2026-10-10'], true, 20261010, null, false, 0, ''].map(date => f.imported('service-records', f.recordData(f.shiftA, { date })));
  const foreign = f.imported('service-records', f.recordData(f.foreignShift), f.foreignAdmin.org);
  await f.unchanged(async () => {
    for (const key of ['admin', 'supervisor', 'finance', 'caregiver']) {
      const client = f.clients[key], result = await f.list('service-records', 'month=2026-10', client);
      assert.deepEqual(ids(result.items), ids(key === 'caregiver' ? own : [...own, other]));
      for (const item of result.items.filter(item => own.some(row => row.id === item.id))) assert.equal(Object.hasOwn(item, 'billingSnapshot'), ['admin', 'finance'].includes(key));
      assert.equal((await f.request(client, 'GET', '/api/service-records/' + foreign.id)).status, 404);
      assert.equal((await f.request(client, 'GET', '/api/service-records/' + foreign.id + '/history')).status, 404);
    }
    assert.equal((await f.list('service-records', '', f.clients.caregiver)).total, own.length + bad.length);
    for (const item of bad) {
      const current = await f.request(f.clients.caregiver, 'GET', '/api/service-records/' + item.id); assert.equal(current.status, 200); assert.deepEqual(current.body.item, item);
    }
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/service-records/' + other.id)).status, 404);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/service-records/' + other.id + '/history')).status, 404);
    assert.deepEqual(ids((await f.list('service-records', 'month=2026-10', f.foreignAdmin)).items), ids([foreign]));
  });
});

test('the same generic month protection applies to training leaves assessments services and undated entity lists', async t => {
  const f = await fixture(t), groups = [
    { entity: 'employee-training', data: { employeeId: f.employeeA.id, name: '合成月份訓練', category: 'other', date: '2026-10-14', trainingMinutes: 60, status: 'completed' }, dateKey: 'date', client: f.clients.caregiver },
    { entity: 'leave-requests', data: { employeeId: f.employeeA.id, date: '2026-10-14', startTime: '12:00', endTime: '13:00', type: '合成假別', reason: '合成原因', status: 'pending' }, dateKey: 'date', client: f.clients.caregiver },
    { entity: 'assessments', data: { caseId: f.caseA.id, templateId: 'synthetic-template', date: '2026-10-14', answers: {}, status: 'draft' }, dateKey: 'date', client: f.admin },
    { entity: 'service-items', data: { code: 'MF-IMPORT-SERVICE', name: '合成月份匯入服務', minutes: 60, unitPriceCents: 0, validFrom: '2026-10-14', status: 'inactive' }, dateKey: 'validFrom', client: f.admin },
    { entity: 'announcements', data: { title: '合成月份公告', body: '合成正文', audience: 'all', status: 'published', date: '2026-10-14' }, dateKey: 'date', client: f.clients.caregiver },
  ];
  const fixtures = groups.map(group => ({ ...group, good: f.imported(group.entity, group.data),
    bad: [{ imported: '2026-10-14' }, ['2026-10-14'], true, 20261014, [], null].map(value => f.imported(group.entity, { ...group.data, [group.dateKey]: value })) }));
  await f.unchanged(async () => {
    for (const group of fixtures) {
      const result = await f.list(group.entity, 'month=2026-10', group.client); assert.deepEqual(ids(result.items), ids([group.good]));
      const raw = await f.list(group.entity, '', group.client); for (const item of [group.good, ...group.bad]) assert.deepEqual(raw.items.find(row => row.id === item.id), item);
    }
    assert.equal((await f.list('cases', 'month=2026-10')).total, 0); assert.equal((await f.list('employees', 'month=2026-10')).total, 0);
    assert.equal((await f.list('cases')).total, 2); assert.equal((await f.list('employees')).total, 2);
  });
});

test('authentication role and organization guards retain their original 401 403 404 semantics before month filtering', async t => {
  const f = await fixture(t); f.imported('shifts', f.shiftData({ date: { imported: 'PRIVATE' } }));
  await f.unchanged(async () => {
    assert.equal((await f.request(null, 'GET', '/api/shifts?month=invalid')).status, 401);
    assert.equal((await f.request(f.admin, 'GET', '/api/shifts?month=2026-10', undefined, { 'X-Org-Id': null })).status, 400);
    for (const client of Object.values(f.clients)) assert.equal((await f.request({ ...client, org: 'synthetic-unknown-org' }, 'GET', '/api/shifts?month=invalid')).status, 403);
    for (const key of ['supervisor', 'finance', 'caregiver']) assert.equal((await f.request({ ...f.clients[key], org: f.foreignAdmin.org }, 'GET', '/api/shifts?month=2026-10')).status, 403);
    assert.equal((await f.request(f.clients.finance, 'GET', '/api/employee-training?month=invalid')).status, 403);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/assessments?month=invalid')).status, 403);
    assert.equal((await f.request(f.clients.supervisor, 'GET', '/api/users?month=2026-10')).status, 403);
    assert.equal((await f.request(f.admin, 'GET', '/api/synthetic-unknown-entity?month=2026-10')).status, 404);
    for (const client of Object.values(f.clients)) {
      assert.equal((await f.request(client, 'GET', '/api/shifts/' + f.foreignShift.id + '?month=2026-10')).status, 404);
      assert.equal((await f.request(client, 'GET', '/api/shifts/' + f.foreignShift.id + '/history')).status, 404);
    }
    for (const key of ['admin', 'supervisor', 'finance']) assert.deepEqual(ids((await f.list('shifts', 'month=2026-10', f.clients[key])).items), ids([f.shiftA, f.shiftB]));
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10', f.clients.caregiver)).items), ids([f.shiftA]));
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10', f.foreignAdmin)).items), ids([f.foreignShift]));
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/shifts/' + f.shiftB.id)).status, 404);
  });
});

test('month validation empty and duplicate parameters and pagination continue their established generic GET behavior', async t => {
  const f = await fixture(t), imported = f.imported('shifts', f.shiftData({ date: { imported: 'PRIVATE' } }));
  await f.unchanged(async () => {
    for (const month of ['2026-0', '2026-00', '2026-13', '2026-1', ' 2026-10', '2026-10 ', '2026-10-01', '26-10', '0000-00']) {
      const result = await f.request(f.admin, 'GET', '/api/shifts?month=' + encodeURIComponent(month)); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH');
    }
    for (const month of ['0000-01', '9999-12']) { const result = await f.list('shifts', 'month=' + month); assert.equal(result.total, 0); }
    for (const query of ['month=', 'month=&month=invalid']) assert.deepEqual(ids((await f.list('shifts', query)).items), ids([f.shiftA, f.shiftB, imported]));
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10&month=invalid')).items), ids([f.shiftA, f.shiftB]));
    const firstInvalid = await f.request(f.admin, 'GET', '/api/shifts?month=invalid&month=2026-10'); assert.equal(firstInvalid.status, 422); assert.equal(firstInvalid.body.error.code, 'INVALID_MONTH');
    for (const query of ['page=0', 'page=-1', 'page=abc', 'pageSize=0', 'pageSize=101']) { const result = await f.request(f.admin, 'GET', '/api/shifts?month=2026-10&' + query); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'PAGINATION'); }
    const order = await f.request(f.admin, 'GET', '/api/shifts?month=invalid&page=0'); assert.equal(order.status, 422); assert.equal(order.body.error.code, 'INVALID_MONTH');
    const item = await f.request(f.admin, 'GET', '/api/shifts/' + imported.id + '?month=invalid&page=0'); assert.equal(item.status, 200); assert.deepEqual(item.body.item, imported);
  });
});

test('read tolerance never relaxes API date validation CSRF roles CAS or idempotent create behavior', async t => {
  const f = await fixture(t), data = f.shiftData({ date: '2026-10-22', note: '合成重送月份班次' });
  await f.unchanged(async () => {
    for (const date of [{ imported: '2026-10-22' }, ['2026-10-22'], true, 20261022, null, 0, false, '', '2026-10-invalid', '2026-10-99', '2026-10-22T09:00:00Z']) {
      assert.equal((await f.request(f.admin, 'POST', '/api/shifts', { ...data, date })).status, 422);
      assert.equal((await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shiftA.id, { version: 1, date })).status, 422);
    }
    for (const client of [f.clients.finance, f.clients.caregiver]) {
      assert.equal((await f.request(client, 'POST', '/api/shifts', data)).status, 403);
      assert.equal((await f.request(client, 'PATCH', '/api/shifts/' + f.shiftA.id, { version: 1, note: '合成越權' })).status, 403);
    }
    assert.equal((await f.request(f.admin, 'POST', '/api/shifts', data, { 'X-CSRF-Token': null })).status, 403);
    assert.equal((await f.request(f.admin, 'POST', '/api/shifts', data, { Origin: 'https://synthetic-invalid-origin.example.test' })).status, 403);
  });
  const first = await f.request(f.admin, 'POST', '/api/shifts', data, { 'Idempotency-Key': 'mf-create-once' }); assert.equal(first.status, 201); const item = first.body.item;
  await f.unchanged(async () => {
    const repeat = await f.request(f.admin, 'POST', '/api/shifts', data, { 'Idempotency-Key': 'mf-create-once' }); assert.equal(repeat.status, 201); assert.deepEqual(repeat.body, first.body);
    const mismatch = await f.request(f.admin, 'POST', '/api/shifts', { ...data, note: '合成不同請求' }, { 'Idempotency-Key': 'mf-create-once' }); assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });
  const updated = await f.request(f.clients.supervisor, 'PATCH', '/api/shifts/' + item.id, { version: 1, note: '合成新版交班' }); assert.equal(updated.status, 200); assert.equal(updated.body.item.version, 2);
  await f.unchanged(async () => {
    const conflict = await f.request(f.admin, 'PATCH', '/api/shifts/' + item.id, { version: 1, note: '合成過期交班' }); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
    assert.deepEqual(ids((await f.list('shifts', 'month=2026-10')).items), ids([f.shiftA, f.shiftB, updated.body.item]));
    const history = await f.request(f.admin, 'GET', '/api/shifts/' + item.id + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.total, 2);
    assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id); assert.equal(history.body.items[0].comparison.previousVersion, 1); assert.deepEqual(history.body.items[1].snapshot, item);
  });
});

test('approved price and payroll snapshots attachments and report refusal remain unchanged during month-filter reads', async t => {
  const f = await fixture(t), submitted = await f.create('service-records', f.recordData(f.shiftA, { status: 'submitted' }), f.clients.caregiver);
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成月份核閱' }); assert.equal(review.status, 200); assert(!Object.hasOwn(review.body.item, 'billingSnapshot'));
  const approvedResult = await f.unchanged(() => f.request(f.admin, 'GET', '/api/service-records/' + submitted.id)), approved = approvedResult.body.item;
  assert.equal(approvedResult.status, 200);
  assert.equal(approved.status, 'approved'); assert.equal(approved.version, 2); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000);
  const cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成月份證照', issuedOn: '2026-01-01' });
  const attachment = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成月份PDF', ...filePayload(PDF_BYTES) });
  const certAttachment = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成月份PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  assert.equal((await f.request(f.admin, 'PATCH', '/api/service-items/' + f.service.id, { version: 1, unitPriceCents: 99999 })).status, 200);
  assert.equal((await f.request(f.admin, 'PATCH', '/api/employees/' + f.employeeA.id, { version: 1, hourlyRateCents: 99999 })).status, 200);
  const invalid = f.imported('service-records', f.recordData(f.shiftB, { date: '2026-10-15', actualStart: 'PRIVATE-BAD-TIME', status: 'draft' }));
  await f.unchanged(async () => {
    const before = f.state(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
    for (const client of [f.admin, f.clients.finance]) {
      const fees = await f.request(client, 'GET', '/api/reports/fees?month=2026-10'), payroll = await f.request(client, 'GET', '/api/reports/payroll?month=2026-10');
      assert.equal(fees.status, 200); assert.equal(fees.body.totals.amountCents, 20000); assert.match(fees.body.note, /未核定/);
      assert.equal(payroll.status, 200); assert.equal(payroll.body.totals.amountCents, 24000); assert.equal(payroll.body.totals.minutes, 60); assert.match(payroll.body.note, /未核定/);
      for (const kind of ['fees', 'payroll']) { const csv = await f.request(client, 'GET', '/api/reports/' + kind + '.csv?month=2026-10'); assert.equal(csv.status, 200); assert.match(csv.body, /未核定/); }
    }
    for (const client of [f.clients.supervisor, f.clients.caregiver]) {
      assert.equal((await f.request(client, 'GET', '/api/reports/fees?month=2026-10')).status, 403);
      assert.equal((await f.request(client, 'GET', '/api/reports/payroll?month=2026-10')).status, 403);
      const result = await f.request(client, 'GET', '/api/service-records/' + approved.id); assert.equal(result.status, 200); assert(!Object.hasOwn(result.body.item, 'billingSnapshot'));
    }
    assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
    assert.deepEqual(ids((await f.list('service-records', 'month=2026-10')).items), ids([approved, invalid]));
    const versions = await f.request(f.admin, 'GET', '/api/service-records/' + approved.id + '/history'); assert.equal(versions.status, 200); assert.deepEqual(versions.body.items[0].snapshot, approved); assert.equal(versions.body.items[1].snapshot.status, 'submitted');
    for (const [url, bytes] of [['/api/case-attachments/' + attachment.id + '/download', PDF_BYTES], ['/api/certification-attachments/' + certAttachment.id + '/download', PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const result = await f.request(f.admin, 'GET', url + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); }
    for (const suffix of ['', '/export', '.csv']) { const result = await f.request(f.admin, 'GET', '/api/service-report' + suffix + '?startDate=2026-10-01&endDate=2026-10-31'); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID'); }
  });
  // Deliberately do not request legacy /api/reports/shifts or /services with
  // typed nonstring dates: that separate legacy-report failure is out of scope.
});
