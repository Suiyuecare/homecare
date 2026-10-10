import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert, business } from '../src/server/model.mjs';
import { toCsv } from '../src/server/reports.mjs';

const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
const pathFor = (endpoint = '/api/shift-report', filters = {}) => endpoint + '?' + new URLSearchParams({ ...range, ...filters });
const endpoints = ['/api/shift-report', '/api/shift-report/export', '/api/shift-report.csv'];
const rowKeys = ['shiftId', 'version', 'date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'status', 'statusLabel', 'note'];
const columnKeys = ['date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'statusLabel', 'version', 'note'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data) {
    const response = await fetch(base + route, {
      method,
      headers: { Origin: base,
        ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = (response.headers.get('content-type') || '').startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
    return { status: response.status, body, bytes, headers: response.headers };
  }
  const password = 'synthetic-shift-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成報表管理員', email: 'report-admin@example.test', password, organizationName: '合成報表甲機構' });
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
  const employeeA = await create('employees', { name: '合成人員甲', employeeNo: 'TEST-E01', hourlyRateCents: 24000, phone: 'PRIVATE-EMPLOYEE-PHONE' });
  const employeeB = await create('employees', { name: '合成人員乙', employeeNo: 'TEST-E02', hourlyRateCents: 99999, phone: 'PRIVATE-OTHER-PHONE' });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA]]) {
    const email = key + '@shift-report.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = client(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-C01', phone: 'PRIVATE-CASE-PHONE', address: 'PRIVATE-CASE-ADDRESS' });
  const caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-C02' });
  const serviceA = await create('service-items', { code: 'TEST-S01', name: '合成服務甲', minutes: 60, unitPriceCents: 10000 });
  const serviceB = await create('service-items', { code: 'TEST-S02', name: '合成服務乙', minutes: 30, unitPriceCents: 5000 });
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }] });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', status: 'scheduled', services: [{ serviceItemId: serviceA.id, quantity: 2 }, { serviceItemId: serviceB.id, quantity: 3 }], note: '合成交班備註' };
  const shift = await create('shifts', shiftData);
  function rawState() {
    return {
      changes: app.db.prepare('SELECT total_changes() AS n').get().n,
      tables: Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'].map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    };
  }
  function bulk(count, overrides = {}) {
    const items = [];
    app.db.exec('BEGIN');
    try {
      for (let n = 0; n < count; n++) items.push(insert(app.db, admin.org, 'shifts', { ...shiftData, status: 'cancelled', note: '', ...overrides }));
      app.db.exec('COMMIT');
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
    return items;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, caseB, serviceA, serviceB, planA, planB, shiftData, shift, rawState, bulk };
}

test('strict report queries share inclusive date limits and reject duplicates, unknown parameters, and invalid pagination', async t => {
  const f = await fixture(t), before = f.rawState();
  const badQueries = [
    '', 'startDate=2026-10-01', 'endDate=2026-10-31',
    'startDate=2026-02-30&endDate=2026-03-01', 'startDate=2026-1-01&endDate=2026-01-31',
    'startDate=2026-10-01T00:00:00Z&endDate=2026-10-31', 'startDate=2026-10-31&endDate=2026-10-01',
    'startDate=2023-01-01&endDate=2024-01-02', 'startDate=2024-01-01&endDate=2025-01-01',
    new URLSearchParams({ ...range, status: 'draft' }).toString(), new URLSearchParams({ ...range, status: ' ' }).toString(),
    new URLSearchParams({ ...range, month: '2026-10' }).toString(), new URLSearchParams({ ...range, format: 'csv' }).toString(),
    new URLSearchParams({ ...range, q: '合成' }).toString(),
    new URLSearchParams(range).toString() + '&startDate=2026-10-01',
    new URLSearchParams(range).toString() + '&caseId=&caseId=',
    new URLSearchParams(range).toString() + '&employeeId=&employeeId=',
    new URLSearchParams(range).toString() + '&status=&status=',
  ];
  for (const endpoint of endpoints) {
    for (const query of badQueries) assert.equal((await f.request(f.admin, 'GET', endpoint + '?' + query)).status, 422, endpoint + '?' + query);
    for (const valid of [{ startDate: '2024-01-01', endDate: '2024-12-31' }, { startDate: '2023-01-01', endDate: '2024-01-01' }, { startDate: '2026-10-08', endDate: '2026-10-08', status: '', caseId: '', employeeId: '' }]) {
      assert.equal((await f.request(f.admin, 'GET', pathFor(endpoint, valid))).status, 200);
    }
  }
  for (const changes of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e0' }, { page: '' }, { page: ' 1' }, { page: '9007199254740992' }, { pageSize: '101' }, { pageSize: '0' }, { pageSize: '25.0' }, { pageSize: '' }]) {
    assert.equal((await f.request(f.admin, 'GET', pathFor('/api/shift-report', changes))).status, 422, JSON.stringify(changes));
  }
  assert.equal((await f.request(f.admin, 'GET', pathFor() + '&page=1&page=1')).status, 422);
  for (const endpoint of endpoints.slice(1)) {
    for (const changes of [{ page: '1' }, { pageSize: '25' }]) assert.equal((await f.request(f.admin, 'GET', pathFor(endpoint, changes))).status, 422);
  }
  assert.deepEqual(f.rawState(), before);
});

test('stable sorting, complete counts and services survive pagination and match full JSON plus CSV exactly', async t => {
  const f = await fixture(t);
  const specs = [
    { date: '2026-10-07', startTime: '09:00', caseId: f.caseA.id, employeeId: f.employeeA.id, carePlanId: f.planA.id },
    { date: '2026-10-07', startTime: '09:00', caseId: f.caseA.id, employeeId: f.employeeB.id, carePlanId: f.planA.id },
    { date: '2026-10-07', startTime: '09:00', caseId: f.caseB.id, employeeId: f.employeeA.id, carePlanId: f.planB.id },
    { date: '2026-10-07', startTime: '09:00', caseId: f.caseB.id, employeeId: f.employeeB.id, carePlanId: f.planB.id },
    { date: '2026-10-07', startTime: '10:00', endTime: '11:00' },
    { date: '2026-10-09', startTime: '08:00' },
  ];
  const ordered = [];
  for (const spec of specs.toReversed()) ordered.unshift(await f.create('shifts', { ...f.shiftData, status: 'cancelled', ...spec }));
  const ties = f.bulk(23, { date: '2026-10-20' });
  const expectedIds = [...ordered.slice(0, 5).map(item => item.id), f.shift.id, ordered[5].id, ...ties.map(item => item.id).sort()];
  const before = f.rawState();
  const first = await f.request(f.admin, 'GET', pathFor()), second = await f.request(f.admin, 'GET', pathFor('/api/shift-report', { page: '2' }));
  const full = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export'));
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(full.status, 200);
  assert.equal(first.body.rows.length, 25); assert.equal(second.body.rows.length, 5);
  assert.equal(first.body.total, 30); assert.equal(first.body.totals.count, 30); assert.equal(second.body.totals.count, 30);
  assert.equal(full.body.page, 1); assert.equal(full.body.pageSize, 30);
  assert.deepEqual([...first.body.rows, ...second.body.rows], full.body.rows);
  assert.deepEqual(full.body.rows.map(row => row.shiftId), expectedIds);
  assert.deepEqual(full.body.columns.map(column => column.key), columnKeys);
  assert.deepEqual(full.body.filters, { ...range, caseId: '', employeeId: '', status: '' });
  assert.deepEqual(full.body.selection, { case: '全部可讀個案', employee: '全部可讀人員', status: '全部狀態' });
  assert.deepEqual(full.body.organization, { name: '合成報表甲機構' }); assert.equal(full.body.title, '班表明細');
  assert.match(full.body.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(full.body.note, /本機測試報表/); assert.match(full.body.note, /目前主檔名稱/); assert.match(full.body.note, /非正式申報/);
  assert.ok(full.body.rows.every(row => row.services === 'TEST-S01 合成服務甲 × 2；TEST-S02 合成服務乙 × 3'));
  for (const row of full.body.rows) assert.deepEqual(Object.keys(row).sort(), rowKeys.toSorted());
  const csv = await f.request(f.admin, 'GET', pathFor('/api/shift-report.csv'));
  assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(full.body));
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8$/);
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="shift-report.csv"');
  for (const response of [first, second, full, csv]) {
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const outside = await f.request(f.admin, 'GET', pathFor('/api/shift-report', { page: '3' }));
  assert.equal(outside.body.total, 30); assert.deepEqual(outside.body.rows, []);
  assert.deepEqual(f.rawState(), before);
});

test('combined filters are inclusive, keep closed or inactive master data and return well-formed empty exports', async t => {
  const f = await fixture(t);
  await f.create('shifts', { ...f.shiftData, date: '2026-10-31', status: 'cancelled' });
  await f.create('shifts', { ...f.shiftData, date: '2026-11-01', status: 'cancelled' });
  const other = await f.create('shifts', { ...f.shiftData, caseId: f.caseB.id, carePlanId: f.planB.id, employeeId: f.employeeB.id, status: 'cancelled' });
  await f.patch('cases', f.caseB, { status: 'closed', name: '合成結案目前姓名' });
  await f.patch('employees', f.employeeB, { status: 'inactive', name: '合成離職目前姓名' });
  const filters = { caseId: f.caseB.id, employeeId: f.employeeB.id, status: 'cancelled', startDate: '2026-10-08', endDate: '2026-10-08' };
  const before = f.rawState();
  const result = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export', filters));
  assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.rows[0].shiftId, other.id);
  assert.deepEqual(result.body.filters, filters);
  assert.deepEqual(result.body.selection, { case: '合成結案目前姓名', employee: '合成離職目前姓名', status: '已取消' });
  const lastDay = await f.request(f.admin, 'GET', pathFor('/api/shift-report', { startDate: '2026-10-31', endDate: '2026-10-31' }));
  assert.equal(lastDay.body.total, 1); assert.equal(lastDay.body.rows[0].date, '2026-10-31');
  const emptyFilters = { caseId: f.caseA.id, employeeId: f.employeeB.id };
  const empty = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export', emptyFilters));
  assert.equal(empty.status, 200); assert.equal(empty.body.page, 1); assert.equal(empty.body.pageSize, 0);
  assert.equal(empty.body.total, 0); assert.equal(empty.body.totals.count, 0); assert.deepEqual(empty.body.rows, []);
  const csv = await f.request(f.admin, 'GET', pathFor('/api/shift-report.csv', emptyFilters));
  assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(empty.body)); assert.equal(csv.body.split('\r\n').length, 3);
  assert.deepEqual(f.rawState(), before);
});

test('four roles reauthorize filter references and current assignments on every list or full export', async t => {
  const f = await fixture(t);
  const otherShift = await f.create('shifts', { ...f.shiftData, caseId: f.caseB.id, carePlanId: f.planB.id, employeeId: f.employeeB.id });
  const otherOrg = await f.create('organizations', { name: '合成報表乙機構' }), elsewhere = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'FOREIGN' }, elsewhere);
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMPLOYEE', employeeNo: 'FOREIGN' }, elsewhere);
  const before = f.rawState();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', pathFor(endpoint))).status, 401);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.caregiver]) {
      const result = await f.request(caller, 'GET', pathFor(endpoint)); assert.equal(result.status, 200);
      if (endpoint !== '/api/shift-report.csv') {
        assert.equal(result.body.total, caller === f.clients.caregiver ? 1 : 2);
        if (caller === f.clients.caregiver) assert.equal(result.body.rows[0].shiftId, f.shift.id);
      }
      for (const filters of [{ caseId: foreignCase.id }, { employeeId: foreignEmployee.id }, { caseId: 'not-an-id' }, { employeeId: 'missing' }]) {
        assert.equal((await f.request(caller, 'GET', pathFor(endpoint, filters))).status, 404);
      }
    }
    for (const filters of [{ caseId: f.caseB.id }, { employeeId: f.employeeB.id }]) {
      assert.equal((await f.request(f.clients.caregiver, 'GET', pathFor(endpoint, filters))).status, 404);
    }
    assert.equal((await f.request(elsewhere, 'GET', pathFor(endpoint, { caseId: f.caseA.id }))).status, 404);
  }
  assert.deepEqual(f.rawState(), before);
  const moved = await f.patch('shifts', f.shift, { employeeId: f.employeeB.id, date: '2026-10-09' }, f.clients.supervisor);
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', pathFor(endpoint, { caseId: f.caseA.id }))).status, 404, 'a formerly permitted case filter is reauthorized');
    const own = await f.request(f.clients.caregiver, 'GET', pathFor(endpoint)); assert.equal(own.status, 200);
    assert.ok(!JSON.stringify(own.body).includes(moved.id)); assert.ok(!JSON.stringify(own.body).includes(otherShift.id));
    const current = await f.request(f.clients.supervisor, 'GET', pathFor(endpoint, { employeeId: f.employeeB.id })); assert.equal(current.status, 200);
    if (endpoint !== '/api/shift-report.csv') {
      assert.equal(current.body.total, 2); assert.equal(current.body.rows.find(row => row.shiftId === moved.id).version, 2);
    }
  }
});

test('CSV uses quoted UTF-8 values and formula protection while all report rows omit private or financial fields', async t => {
  const f = await fixture(t);
  await f.patch('cases', f.caseA, { name: '=HYPERLINK("https://example.test")', caseNo: '+CASE' });
  await f.patch('employees', f.employeeA, { name: '\t公式人員', employeeNo: '-EMP' });
  await f.patch('service-items', f.serviceA, { code: '@SERVICE', name: '合成中文"引號"\n服務' });
  const note = '\n=SUM(1,2)\r\n合成"交班"';
  await f.patch('shifts', f.shift, { note });
  insert(f.app.db, f.admin.org, 'shifts', { ...f.shiftData, status: 'cancelled', billingSnapshot: { marker: 'PRIVATE-BILLING', hourlyRateCents: 123456 }, address: 'PRIVATE-SHIFT-ADDRESS', phone: 'PRIVATE-SHIFT-PHONE', undeclared: 'PRIVATE-UNKNOWN' });
  const before = f.rawState();
  for (const caller of Object.values(f.clients)) {
    const full = await f.request(caller, 'GET', pathFor('/api/shift-report/export'));
    assert.equal(full.status, 200);
    for (const row of full.body.rows) assert.deepEqual(Object.keys(row).sort(), rowKeys.toSorted());
    const serialized = JSON.stringify(full.body);
    for (const forbidden of ['PRIVATE-', 'billingSnapshot', 'hourlyRateCents', 'unitPriceCents', 'address', 'phone', 'undeclared']) assert.ok(!serialized.includes(forbidden), forbidden);
    const csv = await f.request(caller, 'GET', pathFor('/api/shift-report.csv'));
    assert.equal(csv.body, toCsv(full.body));
    assert.ok(csv.body.includes('"\'=HYPERLINK(""https://example.test"")"'));
    assert.ok(csv.body.includes('"\'+CASE"')); assert.ok(csv.body.includes('"\'-EMP"'));
    assert.ok(csv.body.includes('"\'\t公式人員"'));
    assert.ok(csv.body.includes('"\'@SERVICE 合成中文""引號""\n服務 × 2；TEST-S02 合成服務乙 × 3"'));
    assert.ok(csv.body.includes('"\'\n=SUM(1,2)\r\n合成""交班"""'));
    assert.ok(csv.body.endsWith('\r\n'));
  }
  assert.deepEqual(f.rawState(), before);
});

test('missing and foreign related masters use unavailable labels without cross-organization lookups', async t => {
  const f = await fixture(t);
  const otherOrg = await f.create('organizations', { name: '合成禁止跨機構查名' }), elsewhere = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-NAME', caseNo: 'PRIVATE-FOREIGN-NO' }, elsewhere);
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-WORKER', employeeNo: 'PRIVATE-FOREIGN-EMP-NO' }, elsewhere);
  const foreignService = await f.create('service-items', { code: 'PRIVATE-CODE', name: 'PRIVATE-SERVICE', minutes: 60, unitPriceCents: 99 }, elsewhere);
  const malformed = insert(f.app.db, f.admin.org, 'shifts', { ...f.shiftData, status: 'cancelled', caseId: foreignCase.id, employeeId: foreignEmployee.id, services: [{ serviceItemId: foreignService.id, quantity: 4 }, { serviceItemId: 'missing-service', quantity: 2 }] });
  const before = f.rawState();
  const full = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export'));
  assert.equal(full.status, 200);
  const row = full.body.rows.find(item => item.shiftId === malformed.id);
  assert.equal(row.case, '未取得個案名稱'); assert.equal(row.caseNo, '');
  assert.equal(row.employee, '未取得服務人員名稱'); assert.equal(row.employeeNo, '');
  assert.equal(row.services, '未取得服務名稱 × 4；未取得服務名稱 × 2');
  assert.ok(!JSON.stringify(full.body).includes('PRIVATE-'));
  assert.deepEqual(f.rawState(), before);
});

test('1000-row full export boundary is inclusive and oversized reports reject entirely while pagination remains usable', async t => {
  const f = await fixture(t);
  f.bulk(999);
  const before = f.rawState();
  for (const endpoint of endpoints.slice(1)) {
    const response = await f.request(f.admin, 'GET', pathFor(endpoint)); assert.equal(response.status, 200);
    if (endpoint.endsWith('/export')) { assert.equal(response.body.rows.length, 1000); assert.equal(response.body.total, 1000); }
  }
  assert.deepEqual(f.rawState(), before);
  f.bulk(1);
  const tooLargeState = f.rawState();
  for (const endpoint of endpoints.slice(1)) {
    const response = await f.request(f.admin, 'GET', pathFor(endpoint)); assert.equal(response.status, 413);
    assert.equal(response.body.error.code, 'REPORT_TOO_LARGE'); assert.ok(!Object.hasOwn(response.body, 'rows'));
  }
  const page = await f.request(f.admin, 'GET', pathFor('/api/shift-report', { page: '11', pageSize: '100' }));
  assert.equal(page.status, 200); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1);
  assert.deepEqual(f.rawState(), tooLargeState);
});

test('full JSON UTF-8 limit permits exactly 2 MiB and rejects one extra byte for both export formats', async t => {
  const f = await fixture(t);
  const items = f.bulk(249);
  const initial = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export'));
  assert.equal(initial.status, 200); assert.equal(initial.body.total, 250);
  let remaining = 2 * 1024 * 1024 - initial.bytes.length;
  assert.ok(remaining > 0 && remaining < items.length * 10000);
  let last;
  // Memory-only fixture fill, measured in UTF-8 bytes rather than character count.
  for (const item of items) {
    const count = Math.min(9999, remaining);
    const chinese = Math.floor(count / 3), ascii = count % 3;
    const note = '字'.repeat(chinese) + 'x'.repeat(ascii);
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), note }), item.id);
    remaining -= Buffer.byteLength(note, 'utf8'); last = { item, note };
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const before = f.rawState();
  const exact = await f.request(f.admin, 'GET', pathFor('/api/shift-report/export'));
  assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2 * 1024 * 1024);
  assert.equal((await f.request(f.admin, 'GET', pathFor('/api/shift-report.csv'))).status, 200);
  assert.deepEqual(f.rawState(), before);
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(last.item), note: last.note + 'x' }), last.item.id);
  const oversizedState = f.rawState();
  for (const endpoint of endpoints.slice(1)) {
    const response = await f.request(f.admin, 'GET', pathFor(endpoint));
    assert.equal(response.status, 413); assert.equal(response.body.error.code, 'REPORT_TOO_LARGE');
  }
  const page = await f.request(f.admin, 'GET', pathFor('/api/shift-report'));
  assert.equal(page.status, 200); assert.equal(page.body.rows.length, 25); assert.equal(page.body.total, 250);
  assert.deepEqual(f.rawState(), oversizedState);
});

test('fresh report reads preserve all persisted data and approved billing while all five existing reports retain compatibility', async t => {
  const f = await fixture(t);
  const record = await f.create('service-records', { shiftId: f.shift.id, caseId: f.caseA.id, employeeId: f.employeeA.id, date: f.shift.date, actualStart: '09:00', actualEnd: '10:00', services: f.shift.services, status: 'submitted' }, f.clients.caregiver);
  const approved = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved' });
  assert.equal(approved.status, 200);
  await f.patch('service-items', f.serviceA, { unitPriceCents: 99999, name: '合成目前新服務名稱' });
  await f.patch('employees', f.employeeA, { hourlyRateCents: 88888 });
  const oldReports = new Map();
  for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) {
    const response = await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10');
    assert.equal(response.status, 200); oldReports.set(kind, response.body);
  }
  assert.equal(oldReports.get('shifts').columns.length, 6); assert.equal(oldReports.get('shifts').title, '班表');
  assert.equal(oldReports.get('fees').totals.amountCents, 35000); assert.equal(oldReports.get('payroll').totals.amountCents, 24000);
  const before = f.rawState();
  for (const caller of Object.values(f.clients)) {
    for (const endpoint of endpoints) {
      const result = await f.request(caller, 'GET', pathFor(endpoint, { status: 'completed' })); assert.equal(result.status, 200);
      if (endpoint !== '/api/shift-report.csv') {
        assert.equal(result.body.total, 1); assert.equal(result.body.rows[0].statusLabel, '已完成');
        assert.equal(result.body.rows[0].version, 2); assert.match(result.body.rows[0].services, /合成目前新服務名稱/);
      }
    }
  }
  for (const [kind, old] of oldReports) {
    const json = await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10');
    assert.deepEqual(json.body, old);
    for (const route of ['/api/reports/' + kind + '.csv?month=2026-10', '/api/reports/' + kind + '?month=2026-10&format=csv']) {
      const csv = await f.request(f.admin, 'GET', route); assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(old));
    }
  }
  assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/reports/fees?month=2026-10')).status, 403);
  assert.equal((await f.request(f.clients.supervisor, 'GET', '/api/reports/payroll?month=2026-10')).status, 403);
  assert.deepEqual(f.rawState(), before);
});
