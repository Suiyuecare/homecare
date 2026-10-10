import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert, business } from '../src/server/model.mjs';
import { toCsv } from '../src/server/reports.mjs';

const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
const endpoints = ['/api/case-report', '/api/case-report/export', '/api/case-report.csv'];
const url = (endpoint = endpoints[0], filters = {}) => endpoint + '?' + new URLSearchParams({ ...range, ...filters });
const rowKeys = ['caseId', 'version', 'createdDate', 'caseNo', 'name', 'gender', 'cmsLevel', 'welfare', 'status', 'statusLabel', 'supervisorNo', 'supervisor', 'createdAt', 'updatedAt', 'note'];
const columns = [
  ['createdDate', '系統建立日期（臺北）'], ['caseNo', '案號'], ['name', '個案'], ['gender', '性別'],
  ['cmsLevel', 'CMS 等級'], ['welfare', '福利身分別'], ['statusLabel', '個案狀態'], ['supervisorNo', '督導編號'],
  ['supervisor', '主責督導'], ['version', '版次'], ['updatedAt', '系統更新時間'], ['note', '個案備註'],
].map(([key, label]) => ({ key, label }));
const labels = { active: '服務中', paused: '暫停', closed: '結案' };

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, headers: response.headers, body: (response.headers.get('content-type') || '').startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const password = 'synthetic-case-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成個案報表管理員', email: 'case-admin@example.test', password, organizationName: '合成個案報表甲機構' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id });
  const admin = client(setup);
  async function create(entity, data, caller = admin) {
    const response = await request(caller, 'POST', '/api/' + entity, data);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(entity, item, changes, caller = admin) {
    const response = await request(caller, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...changes });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成居服甲', employeeNo: 'TEST-E01', hourlyRateCents: 24000, phone: 'PRIVATE-EMP-PHONE' });
  const employeeB = await create('employees', { name: '合成督導乙', employeeNo: 'TEST-E02', role: 'supervisor', hourlyRateCents: 99999 });
  const unassignedEmployee = await create('employees', { name: '合成未指派督導', employeeNo: 'TEST-E03', role: 'supervisor' });
  const clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@case-report.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-C01', supervisorId: employeeB.id, birthDate: '1940-01-01', gender: '女', cmsLevel: 3, welfare: '合成福利文字', note: '合成個案備註', phone: 'PRIVATE-PHONE', address: 'PRIVATE-ADDRESS', contactName: 'PRIVATE-CONTACT', contactPhone: 'PRIVATE-CONTACT-PHONE', primaryCarer: 'PRIVATE-CARER' });
  const caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-C02', supervisorId: employeeA.id });
  function dates(item, createdAt = '2026-10-08T00:00:00.000Z', updatedAt = createdAt) {
    // Imported timestamps exist only in this isolated memory fixture; no history is rewritten.
    app.db.prepare('UPDATE records SET created_at=?,updated_at=? WHERE id=?').run(createdAt, updatedAt, item.id);
    return { ...item, createdAt, updatedAt };
  }
  dates(caseA); dates(caseB);
  const service = await create('service-items', { code: 'TEST-S01', name: '合成服務', minutes: 60, unitPriceCents: 10000 });
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 30 }] });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', status: 'scheduled', services: [{ serviceItemId: service.id, quantity: 1 }] };
  const shift = await create('shifts', shiftData);
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'].map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  let index = 0;
  function bulk(count, overrides = {}) {
    const items = []; app.db.exec('BEGIN');
    try {
      for (let n = 0; n < count; n++) {
        const { createdAt = '2026-10-20T00:00:00.000Z', updatedAt = createdAt, ...changes } = typeof overrides === 'function' ? overrides(n) : overrides;
        const item = insert(app.db, admin.org, 'cases', { caseNo: 'TEST-B' + String(index++).padStart(5, '0'), name: '合成匯入個案', status: 'active', note: '', ...changes });
        items.push(dates(item, createdAt, updatedAt));
      }
      app.db.exec('COMMIT');
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
    return items;
  }
  const overwrite = (item, changes) => app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), ...changes }), item.id);
  return { app, request, create, patch, admin, clients, employeeA, employeeB, unassignedEmployee, caseA, caseB, service, planA, planB, shiftData, shift, state, dates, bulk, overwrite };
}

test('case query shares strict inclusive dates and pagination while accepting supervisorId only', async t => {
  const f = await fixture(t), before = f.state();
  const bad = ['', 'startDate=2026-10-01', 'endDate=2026-10-31', 'startDate=2026-02-30&endDate=2026-03-01', 'startDate=2026-1-01&endDate=2026-01-31', 'startDate=2026-10-31&endDate=2026-10-01', 'startDate=2023-01-01&endDate=2024-01-02', 'startDate=2024-01-01&endDate=2025-01-01'];
  for (const addition of ['status=draft', 'status=scheduled', 'status=%20', 'employeeId=', 'month=2026-10', 'format=csv', 'q=合成', 'startDate=2026-10-01', 'caseId=&caseId=', 'supervisorId=&supervisorId=', 'status=&status=']) bad.push(new URLSearchParams(range) + '&' + addition);
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', url(endpoint))).status, 401);
    for (const query of bad) assert.equal((await f.request(f.admin, 'GET', endpoint + '?' + query)).status, 422, endpoint + '?' + query);
    for (const valid of [{ startDate: '2024-01-01', endDate: '2024-12-31' }, { startDate: '2023-01-01', endDate: '2024-01-01' }, { startDate: '2026-10-08', endDate: '2026-10-08', caseId: '', supervisorId: '', status: '' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, valid))).status, 200);
    for (const status of Object.keys(labels)) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { status }))).status, 200);
  }
  for (const changes of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e0' }, { page: '' }, { page: '9007199254740992' }, { pageSize: '101' }, { pageSize: '0' }, { pageSize: '25.0' }, { pageSize: '' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], changes))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', url() + '&page=1&page=1')).status, 422);
  for (const endpoint of endpoints.slice(1)) for (const changes of [{ page: '1' }, { pageSize: '25' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, changes))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', url('/api/shift-report', { supervisorId: '' }))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', url('/api/service-report', { supervisorId: '' }))).status, 422);
  assert.deepEqual(f.state(), before);
});

test('40 current cases paginate 25 plus 15 with stable date/code/id sorting and identical full JSON/CSV', async t => {
  const f = await fixture(t);
  f.bulk(38, n => ({ createdAt: n < 18 ? '2026-10-31T15:59:59.999Z' : '2026-10-31T16:00:00.000Z', status: ['active', 'paused', 'closed'][n % 3], supervisorId: n % 2 ? f.employeeA.id : f.employeeB.id }));
  const filters = { endDate: '2026-11-01' }, before = f.state();
  const first = await f.request(f.admin, 'GET', url(endpoints[0], filters)), second = await f.request(f.admin, 'GET', url(endpoints[0], { ...filters, page: '2' })), full = await f.request(f.admin, 'GET', url(endpoints[1], filters));
  for (const result of [first, second, full]) { assert.equal(result.status, 200); assert.equal(result.body.total, 40); assert.deepEqual(result.body.totals, { count: 40 }); assert.deepEqual(result.body.columns, columns); }
  assert.equal(first.body.rows.length, 25); assert.equal(second.body.rows.length, 15); assert.equal(full.body.page, 1); assert.equal(full.body.pageSize, 40);
  assert.deepEqual([...first.body.rows, ...second.body.rows], full.body.rows);
  const sorted = full.body.rows.toSorted((a, b) => { for (const key of ['createdDate', 'caseNo', 'caseId']) { if (a[key] < b[key]) return -1; if (a[key] > b[key]) return 1; } return 0; }); assert.deepEqual(full.body.rows, sorted);
  assert.deepEqual(full.body.rows.reduce((acc, row) => (acc[row.createdDate] = (acc[row.createdDate] || 0) + 1, acc), {}), { '2026-10-08': 2, '2026-10-31': 18, '2026-11-01': 20 });
  assert.deepEqual(full.body.filters, { ...range, ...filters, caseId: '', supervisorId: '', status: '' }); assert.deepEqual(full.body.selection, { case: '全部可讀個案', supervisor: '全部可讀主責督導', status: '全部狀態' });
  const csv = await f.request(f.admin, 'GET', url(endpoints[2], filters)); assert.equal(csv.body, toCsv(full.body)); assert.equal(csv.bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="case-report.csv"'); assert.equal(csv.headers.get('cache-control'), 'no-store'); assert.equal(csv.headers.get('x-content-type-options'), 'nosniff'); assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.deepEqual(f.state(), before);
});

test('supervisor intersection comes from all readable cases, preserving inactive or changed-role assignments and well-formed empty results', async t => {
  const f = await fixture(t);
  await f.patch('employees', f.employeeB, { status: 'inactive', role: '合成其他職務' });
  await f.patch('cases', f.caseB, { status: 'closed' });
  const before = f.state();
  const chosen = await f.request(f.admin, 'GET', url(endpoints[1], { caseId: f.caseA.id, supervisorId: f.employeeB.id, status: 'active' }));
  assert.equal(chosen.status, 200); assert.equal(chosen.body.total, 1); assert.equal(chosen.body.rows[0].supervisor, f.employeeB.name); assert.equal(chosen.body.rows[0].supervisorNo, f.employeeB.employeeNo);
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.admin, 'GET', url(endpoint, { supervisorId: f.unassignedEmployee.id }))).status, 404);
    const empty = await f.request(f.admin, 'GET', url(endpoint, { startDate: '2025-01-01', endDate: '2025-01-31', caseId: f.caseA.id, supervisorId: f.employeeA.id, status: 'active' }));
    assert.equal(empty.status, 200, 'assigned supervisor is valid even outside chosen case/status/date');
    if (endpoint !== endpoints[2]) { assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.rows, []); assert.deepEqual(empty.body.totals, { count: 0 }); assert.equal(empty.body.selection.supervisor, f.employeeA.name); if (endpoint === endpoints[1]) assert.equal(empty.body.pageSize, 0); }
  }
  assert.deepEqual(f.state(), before);
});

test('four roles and every output reauthorize current own-shift cases and assigned supervisor references', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' }), outsider = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'PRIVATE-CODE' }, outsider), foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMP', employeeNo: 'PRIVATE-EMP' }, outsider);
  const before = f.state();
  for (const [role, caller] of Object.entries(f.clients)) for (const endpoint of endpoints) {
    const result = await f.request(caller, 'GET', url(endpoint)); assert.equal(result.status, 200);
    if (endpoint !== endpoints[2]) { assert.equal(result.body.total, role === 'caregiver' ? 1 : 2); if (role === 'caregiver') { assert.equal(result.body.rows[0].supervisor, '主責督導名稱未取得'); assert.equal(result.body.rows[0].supervisorNo, ''); assert.ok(!JSON.stringify(result.body).includes(f.employeeB.id)); } }
    for (const filter of [{ caseId: foreignCase.id }, { supervisorId: foreignEmployee.id }, { caseId: 'missing' }, { supervisorId: 'missing' }, { supervisorId: f.unassignedEmployee.id }]) assert.equal((await f.request(caller, 'GET', url(endpoint, filter))).status, 404);
    if (role === 'caregiver') for (const filter of [{ caseId: f.caseB.id }, { supervisorId: f.employeeB.id }, { supervisorId: f.employeeA.id }]) assert.equal((await f.request(caller, 'GET', url(endpoint, filter))).status, 404);
  }
  assert.deepEqual(f.state(), before);
  const cancelled = await f.patch('shifts', f.shift, { status: 'cancelled' });
  assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1]))).body.total, 1, 'cancelled own shift still grants case access');
  await f.patch('shifts', cancelled, { caseId: f.caseB.id, carePlanId: f.planB.id, date: '2026-01-01' });
  const moved = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint, { caseId: f.caseA.id }))).status, 404);
    const result = await f.request(f.clients.caregiver, 'GET', url(endpoint, { supervisorId: f.employeeA.id })); assert.equal(result.status, 200);
    if (endpoint !== endpoints[2]) { assert.equal(result.body.total, 1); assert.equal(result.body.rows[0].caseId, f.caseB.id); assert.equal(result.body.rows[0].supervisor, f.employeeA.name); }
  }
  assert.deepEqual(f.state(), moved);
});

test('saved ISO timestamps convert to Taipei dates across seconds, month, leap-day and legal offset boundaries', async t => {
  const f = await fixture(t);
  const pairs = [
    ['2026-10-08T15:59:59.999Z', '2026-10-08'], ['2026-10-08T16:00:00Z', '2026-10-09'],
    ['2026-10-31T16:00:00.0Z', '2026-11-01'], ['2026-11-01T00:00:00.12+08:00', '2026-11-01'],
    ['2026-10-31T12:00:00.123-04:00', '2026-11-01'], ['2026-10-31T23:59:59+08:00', '2026-10-31'],
    ['2024-02-29T16:00:00Z', '2024-03-01'], ['2024-02-29T00:00:00+00:00', '2024-02-29'],
  ];
  for (const [saved, day] of pairs) {
    f.dates(f.caseA, saved, saved); const before = f.state();
    const result = await f.request(f.admin, 'GET', url(endpoints[1], { startDate: day, endDate: day, caseId: f.caseA.id })); assert.equal(result.status, 200, saved); assert.equal(result.body.total, 1);
    assert.equal(result.body.rows[0].createdDate, day); assert.equal(result.body.rows[0].createdAt, saved); assert.equal(result.body.rows[0].updatedAt, saved); assert.ok(!JSON.stringify(result.body).includes('1940-01-01'));
    assert.deepEqual(f.state(), before);
  }
});

test('invalid candidate creation times and every matching update time fail whole reports before pagination without identity disclosure', async t => {
  const f = await fixture(t); f.bulk(27);
  const [bad] = f.bulk(1, { caseNo: 'ZZ-LAST', supervisorId: f.employeeA.id, status: 'paused' });
  const invalid = ['', 'not-a-time', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-08', '2026-10-08T09:00:00', '2026-10-08T24:00:00Z', '2026-10-08T00:60:00Z', '2026-10-08T00:00:60Z', '2026-10-08T00:00:00.1234Z', '2026-10-08T00:00:00+24:00', '2026-10-08T00:00:00+08:60', '2026-10-08 00:00:00Z', '2026-10-08T00:00:00z'];
  for (const value of invalid) {
    f.dates(bad, value); const before = f.state();
    for (const endpoint of endpoints) {
      const response = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(response.status, 409, value); assert.equal(response.body.error.code, 'REPORT_DATA_INVALID'); assert.ok(!Object.hasOwn(response.body, 'rows')); assert.ok(!JSON.stringify(response.body).includes(bad.id));
      assert.equal((await f.request(f.admin, 'GET', url(endpoint, { startDate: '2025-01-01', endDate: '2025-01-31' }))).status, 409, 'cannot silently discard invalid createdAt as out-of-date');
      for (const filter of [{ status: 'active' }, { caseId: f.caseA.id }, { supervisorId: f.employeeB.id }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200, 'unreadable malformed case cannot block own report');
    }
    assert.deepEqual(f.state(), before);
  }
  for (const value of invalid) {
    f.dates(bad, '2026-10-31T15:00:00Z', value); const before = f.state();
    for (const endpoint of endpoints) {
      assert.equal((await f.request(f.admin, 'GET', url(endpoint))).status, 409, 'matching invalid update after first page must fail');
      assert.equal((await f.request(f.admin, 'GET', url(endpoint, { endDate: '2026-10-20' }))).status, 200, 'nonmatching update timestamp is not projected');
    }
    assert.deepEqual(f.state(), before);
  }
});

test('unknown or foreign supervisor masters never widen lookup; unassigned names and raw CMS text keep explicit meaning', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' }), caller = { ...f.admin, org: org.id };
  const foreign = await f.create('employees', { name: 'PRIVATE-FOREIGN-SUP', employeeNo: 'PRIVATE-SUP' }, caller);
  const variants = [{ supervisorId: '', cmsLevel: '' }, { supervisorId: 'PRIVATE-MISSING-ID', cmsLevel: null }, { supervisorId: foreign.id, cmsLevel: '歷史原文字 3級（未核定）' }, { cmsLevel: 8 }, {}];
  const items = f.bulk(variants.length, n => variants[n]), before = f.state();
  const result = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(result.status, 200);
  const actual = items.map(item => result.body.rows.find(row => row.caseId === item.id));
  assert.deepEqual(actual.map(row => row.cmsLevel), ['', '', '歷史原文字 3級（未核定）', '8', '']);
  assert.deepEqual(actual.map(row => row.supervisor), ['尚未指定', '主責督導名稱未取得', '主責督導名稱未取得', '尚未指定', '尚未指定']);
  assert.ok(actual.every(row => row.supervisorNo === '')); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-')); assert.ok(!JSON.stringify(result.body).includes(foreign.id));
  assert.deepEqual(f.state(), before);
});

test('all roles receive exactly the case whitelist and safe CSV without contacts, birth dates or financial snapshots', async t => {
  const f = await fixture(t);
  let item = await f.patch('cases', f.caseA, { name: '=HYPERLINK("https://example.test")', caseNo: '+CASE', gender: '@文字', welfare: '-福利', note: '\n=SUM(1,2)\r\n合成"備註"' });
  f.overwrite(item, { billingSnapshot: { marker: 'PRIVATE-BILLING' }, unknownField: 'PRIVATE-UNKNOWN' });
  await f.patch('employees', f.employeeB, { name: '\t督導"姓名"\n第二行', employeeNo: '-SUP' });
  const before = f.state();
  for (const [role, caller] of Object.entries(f.clients)) {
    const full = await f.request(caller, 'GET', url(endpoints[1])); assert.equal(full.status, 200);
    for (const row of full.body.rows) { assert.deepEqual(Object.keys(row).sort(), rowKeys.toSorted()); for (const key of rowKeys) if (key !== 'version') assert.equal(typeof row[key], 'string', key); assert.ok(Number.isSafeInteger(row.version) && row.version > 0); }
    for (const forbidden of ['PRIVATE-', '1940-01-01', 'billingSnapshot', 'hourlyRateCents', 'unitPriceCents', 'address', 'phone', 'birthDate', 'contactName', 'primaryCarer', 'unknownField', 'supervisorId']) assert.ok(!JSON.stringify(full.body.rows).includes(forbidden), forbidden);
    const csv = await f.request(caller, 'GET', url(endpoints[2])); assert.equal(csv.body, toCsv(full.body));
    for (const expected of ['"\'=HYPERLINK(""https://example.test"")"', '"\'+CASE"', '"\'@文字"', '"\'-福利"', '"\'\n=SUM(1,2)\r\n合成""備註"""']) assert.ok(csv.body.includes(expected), expected);
    if (role !== 'caregiver') { assert.ok(csv.body.includes('"\'-SUP"')); assert.ok(csv.body.includes('"\'\t督導""姓名""\n第二行"')); }
  }
  assert.deepEqual(f.state(), before);
});

test('real case writes keep creation time, increment history/audit, and fresh reporting reflects edit/pause/resume/closure', async t => {
  const f = await fixture(t); let item = await f.create('cases', { name: '合成真新增', caseNo: 'TEST-NEW', birthDate: '1941-03-01', cmsLevel: 2 });
  const createdAt = item.createdAt, day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(createdAt));
  const filters = { startDate: day, endDate: day, caseId: item.id };
  for (const change of [null, { name: '合成目前姓名', note: '合成目前備註', supervisorId: f.employeeB.id }, { status: 'paused' }, { status: 'active' }, { status: 'closed' }]) {
    if (change) item = await f.patch('cases', item, change, f.clients.supervisor);
    const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', url(endpoint, filters)); assert.equal(result.status, 200);
      if (endpoint !== endpoints[2]) { const row = result.body.rows[0]; assert.equal(row.version, item.version); assert.equal(row.name, item.name); assert.equal(row.statusLabel, labels[item.status]); assert.equal(row.createdAt, createdAt); assert.equal(row.createdDate, day); assert.equal(row.updatedAt, item.updatedAt); }
    }
    assert.deepEqual(f.state(), before);
  }
  const history = (await f.request(f.admin, 'GET', '/api/cases/' + item.id + '/history?compare=previous')).body.items;
  assert.equal(history.length, 5); assert.deepEqual(history.map(row => row.version), [5, 4, 3, 2, 1]);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM audit WHERE entity='cases' AND record_id=? AND action IN ('record.create','record.update')").get(item.id).n, 5);
  for (const role of ['finance', 'caregiver']) assert.equal((await f.request(f.clients[role], 'PATCH', '/api/cases/' + f.caseA.id, { version: 1, status: 'closed' })).status, 403);
});

test('exact 1000-case exports are complete and 1001 refuse both full formats without restricting pagination', async t => {
  const f = await fixture(t); f.bulk(998); const before = f.state();
  const full = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000); assert.deepEqual(full.body.totals, { count: 1000 });
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2]))).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  f.bulk(1); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); assert.ok(!Object.hasOwn(result.body, 'rows')); }
  const page = await f.request(f.admin, 'GET', url(endpoints[0], { page: '11', pageSize: '100' })); assert.equal(page.status, 200); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1); assert.deepEqual(f.state(), oversized);
});

test('full case JSON permits exactly 2097152 UTF-8 bytes and both full formats reject one extra byte', async t => {
  const f = await fixture(t), items = f.bulk(248);
  const initial = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(initial.status, 200);
  let remaining = 2 * 1024 * 1024 - initial.bytes.length, last;
  assert.ok(remaining > 0 && remaining < items.length * 10000);
  for (const item of items) {
    const count = Math.min(9999, remaining), note = '字'.repeat(Math.floor(count / 3)) + 'x'.repeat(count % 3);
    f.overwrite(item, { note }); remaining -= Buffer.byteLength(note, 'utf8'); last = { item, note }; if (!remaining) break;
  }
  assert.equal(remaining, 0); const before = f.state();
  const exact = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2097152); assert.equal((await f.request(f.admin, 'GET', url(endpoints[2]))).status, 200); assert.deepEqual(f.state(), before);
  f.overwrite(last.item, { note: last.note + 'x' }); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); }
  const page = await f.request(f.admin, 'GET', url()); assert.equal(page.status, 200); assert.equal(page.body.total, 250); assert.equal(page.body.rows.length, 25); assert.deepEqual(f.state(), oversized);
});

test('case reads preserve all eleven tables, approved billing and all five legacy plus shift/service report contracts', async t => {
  const f = await fixture(t);
  const draft = await f.create('service-records', { shiftId: f.shift.id, caseId: f.caseA.id, employeeId: f.employeeA.id, date: f.shift.date, actualStart: '09:05', actualEnd: '09:52', status: 'draft', services: [{ serviceItemId: f.service.id, quantity: 3 }] }, f.clients.caregiver);
  const submitted = await f.patch('service-records', draft, { status: 'submitted' }, f.clients.caregiver);
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + draft.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成核准' }); assert.equal(review.status, 200);
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + draft.id)).body.item;
  await f.patch('service-items', f.service, { unitPriceCents: 99999 }); await f.patch('employees', f.employeeA, { hourlyRateCents: 88888 });
  const legacy = new Map(); for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) legacy.set(kind, (await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body);
  const other = new Map(); for (const type of ['shift', 'service']) for (const suffix of ['', '/export', '.csv']) { const path = url('/api/' + type + '-report' + suffix); other.set(path, await f.request(f.admin, 'GET', path)); }
  const before = f.state();
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) assert.equal((await f.request(caller, 'GET', url(endpoint))).status, 200);
  assert.equal(legacy.get('fees').totals.amountCents, 30000); assert.equal(legacy.get('payroll').totals.amountCents, 18800);
  for (const [kind, old] of legacy) {
    assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body, old);
    for (const path of ['/api/reports/' + kind + '.csv?month=2026-10', '/api/reports/' + kind + '?month=2026-10&format=csv']) assert.equal((await f.request(f.admin, 'GET', path)).body, toCsv(old));
  }
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/cases?month=2025-01')).body, legacy.get('cases'), 'legacy cases continues to ignore valid month filtering');
  for (const [path, old] of other) { const current = await f.request(f.admin, 'GET', path); assert.equal(current.status, old.status); if (typeof old.body === 'string') assert.equal(current.body, old.body); else assert.deepEqual({ ...current.body, generatedAt: '' }, { ...old.body, generatedAt: '' }); }
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + draft.id)).body.item, approved);
  assert.deepEqual(f.state(), before);
});
