import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert, business } from '../src/server/model.mjs';
import { toCsv } from '../src/server/reports.mjs';

const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
const endpoints = ['/api/service-report', '/api/service-report/export', '/api/service-report.csv'];
const url = (endpoint = endpoints[0], filters = {}) => endpoint + '?' + new URLSearchParams({ ...range, ...filters });
const rowKeys = ['recordId', 'version', 'date', 'caseNo', 'case', 'employeeNo', 'employee', 'actualStart', 'actualEnd', 'serviceMinutes', 'services', 'status', 'statusLabel', 'note', 'reviewNote'];
const columnKeys = ['date', 'caseNo', 'case', 'employeeNo', 'employee', 'actualStart', 'actualEnd', 'serviceMinutes', 'services', 'statusLabel', 'version', 'note', 'reviewNote'];
const labels = { draft: '草稿', submitted: '待核閱', approved: '已核准', returned: '退回修改' };

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
  const password = 'synthetic-service-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成服務報表管理員', email: 'service-admin@example.test', password, organizationName: '合成服務報表甲機構' });
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
  const employeeB = await create('employees', { name: '合成人員乙', employeeNo: 'TEST-E02', hourlyRateCents: 99999 });
  const clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@service-report.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-C01', phone: 'PRIVATE-PHONE', address: 'PRIVATE-ADDRESS' });
  const caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-C02' });
  const serviceA = await create('service-items', { code: 'TEST-S01', name: '合成服務甲', minutes: 60, unitPriceCents: 10000 });
  const serviceB = await create('service-items', { code: 'TEST-S02', name: '合成服務乙', minutes: 30, unitPriceCents: 5000 });
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }] });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', status: 'scheduled', services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }] };
  const shift = await create('shifts', shiftData);
  const recordData = { shiftId: shift.id, caseId: caseA.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:50', status: 'draft', services: [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 1 }], note: '合成服務備註' };
  const record = await create('service-records', recordData, clients.caregiver);
  function state() {
    return { changes: app.db.prepare('SELECT total_changes() AS n').get().n,
      tables: Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'].map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    };
  }
  let bulkIndex = 0;
  function bulk(count, overrides = {}) {
    const items = [], clock = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
    app.db.exec('BEGIN');
    try {
      for (let n = 0; n < count; n++) {
        const changes = typeof overrides === 'function' ? overrides(n) : overrides;
        const minute = bulkIndex++, date = changes.date || '2026-10-20';
        const planned = insert(app.db, admin.org, 'shifts', { ...shiftData, caseId: changes.caseId || caseA.id, employeeId: changes.employeeId || employeeA.id, carePlanId: changes.caseId === caseB.id ? planB.id : planA.id, date, startTime: clock(minute), endTime: clock(minute + 1) });
        items.push(insert(app.db, admin.org, 'service-records', { ...recordData, shiftId: planned.id, date, actualStart: planned.startTime, actualEnd: planned.endTime, note: '', ...changes }));
      }
      app.db.exec('COMMIT');
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
    return items;
  }
  function overwrite(item, changes) {
    app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), ...changes }), item.id);
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, caseB, serviceA, serviceB, planA, planB, shiftData, shift, recordData, record, state, bulk, overwrite };
}

test('service query keeps strict shared date, duplicate, unknown, pagination and endpoint-specific status rules', async t => {
  const f = await fixture(t), before = f.state();
  const bad = ['', 'startDate=2026-10-01', 'endDate=2026-10-31', 'startDate=2026-02-30&endDate=2026-03-01', 'startDate=2026-1-01&endDate=2026-01-31', 'startDate=2026-10-31&endDate=2026-10-01', 'startDate=2023-01-01&endDate=2024-01-02'];
  for (const addition of ['status=scheduled', 'status=completed', 'status=cancelled', 'status=%20', 'month=2026-10', 'format=csv', 'q=合成', 'startDate=2026-10-01', 'caseId=&caseId=', 'employeeId=&employeeId=', 'status=&status=']) bad.push(new URLSearchParams(range) + '&' + addition);
  for (const endpoint of endpoints) {
    for (const query of bad) assert.equal((await f.request(f.admin, 'GET', endpoint + '?' + query)).status, 422, endpoint + '?' + query);
    for (const valid of [{ startDate: '2024-01-01', endDate: '2024-12-31' }, { startDate: '2023-01-01', endDate: '2024-01-01' }, { startDate: '2026-10-08', endDate: '2026-10-08', caseId: '', employeeId: '', status: '' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, valid))).status, 200);
    for (const status of Object.keys(labels)) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { status }))).status, 200);
  }
  for (const changes of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e0' }, { page: '' }, { page: '9007199254740992' }, { pageSize: '101' }, { pageSize: '0' }, { pageSize: '25.0' }, { pageSize: '' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], changes))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', url() + '&page=1&page=1')).status, 422);
  for (const endpoint of endpoints.slice(1)) for (const changes of [{ page: '1' }, { pageSize: '25' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, changes))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', url('/api/shift-report', { status: 'draft' }))).body.error.message, '不支援的班次狀態');
  assert.deepEqual(f.state(), before);
});

test('40 records across statuses and date boundaries paginate with whole-result minutes and export the same actual quantities', async t => {
  const f = await fixture(t);
  f.bulk(39, n => ({ status: ['submitted', 'approved', 'returned', 'draft'][n % 4], date: n < 19 ? '2026-10-31' : '2026-11-01' }));
  const filters = { endDate: '2026-11-01' }, before = f.state();
  const first = await f.request(f.admin, 'GET', url(endpoints[0], filters));
  const second = await f.request(f.admin, 'GET', url(endpoints[0], { ...filters, page: '2' }));
  const full = await f.request(f.admin, 'GET', url(endpoints[1], filters));
  assert.equal(first.status, 200); assert.equal(full.status, 200);
  assert.equal(first.body.rows.length, 25); assert.equal(second.body.rows.length, 15);
  for (const result of [first.body, second.body, full.body]) assert.deepEqual(result.totals, { count: 40, serviceMinutes: 84 });
  assert.deepEqual([...first.body.rows, ...second.body.rows], full.body.rows);
  assert.equal(full.body.total, 40); assert.equal(full.body.page, 1); assert.equal(full.body.pageSize, 40);
  assert.equal(full.body.title, '服務紀錄明細'); assert.deepEqual(full.body.columns.map(c => c.key), columnKeys);
  assert.deepEqual(full.body.organization, { name: '合成服務報表甲機構' });
  assert.deepEqual(full.body.filters, { ...range, ...filters, caseId: '', employeeId: '', status: '' });
  assert.deepEqual(full.body.selection, { case: '全部可讀個案', employee: '全部可讀人員', status: '全部狀態' });
  assert.match(full.body.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(full.body.note, /實際紀錄數量/); assert.match(full.body.note, /分鐘包含所選/); assert.match(full.body.note, /非正式申報與薪資依據/);
  assert.ok(full.body.rows.every(row => row.services === 'TEST-S01 合成服務甲 × 3；TEST-S02 合成服務乙 × 1'));
  for (const row of full.body.rows) assert.deepEqual(Object.keys(row).sort(), rowKeys.toSorted());
  const original = full.body.rows.find(row => row.recordId === f.record.id);
  assert.equal(original.serviceMinutes, 45, 'actual record minutes differ from the 60-minute shift and nominal service durations');
  for (const [status, label] of Object.entries(labels)) {
    const result = await f.request(f.admin, 'GET', url(endpoints[1], { ...filters, status }));
    assert.equal(result.body.total, 10); assert.equal(result.body.selection.status, label);
    assert.equal(result.body.totals.serviceMinutes, status === 'draft' ? 54 : 10);
  }
  const csv = await f.request(f.admin, 'GET', url(endpoints[2], filters));
  assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(full.body));
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="service-report.csv"');
  assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8$/);
  for (const response of [first, full, csv]) { assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); }
  const empty = await f.request(f.admin, 'GET', url(endpoints[1], { ...filters, caseId: f.caseB.id }));
  assert.deepEqual(empty.body.totals, { count: 0, serviceMinutes: 0 }); assert.equal(empty.body.pageSize, 0); assert.deepEqual(empty.body.rows, []);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { caseId: f.caseB.id }))).body, toCsv(empty.body));
  assert.deepEqual(f.state(), before);
});

test('HH:mm and ISO actual starts sort by wall-clock minute with raw values, seconds and offsets preserved', async t => {
  const f = await fixture(t);
  const specs = [
    { actualStart: '09:00', actualEnd: '09:47' },
    { actualStart: '08:00', actualEnd: '08:45', caseId: f.caseB.id },
    { actualStart: '2026-10-20T08:00:59+14:00', actualEnd: '2026-10-20T08:45:01-12:00', employeeId: f.employeeB.id },
    { actualStart: '2026-10-20T08:00:01Z', actualEnd: '2026-10-20T08:45:59Z' },
    { actualStart: '08:00', actualEnd: '08:45' },
    { actualStart: '2026-10-20T07:30:59+08:00', actualEnd: '2026-10-20T08:15:00+08:00' },
  ];
  const items = f.bulk(specs.length, n => specs[n]);
  const before = f.state(), response = await f.request(f.admin, 'GET', url(endpoints[1], { startDate: '2026-10-20', endDate: '2026-10-20' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rows.map(row => row.recordId), [items[5].id, ...[items[3].id, items[4].id].sort(), items[2].id, items[1].id, items[0].id]);
  assert.equal(response.body.totals.serviceMinutes, 272);
  for (let n = 0; n < items.length; n++) {
    const row = response.body.rows.find(row => row.recordId === items[n].id);
    assert.equal(row.actualStart, specs[n].actualStart); assert.equal(row.actualEnd, specs[n].actualEnd);
    assert.equal(row.serviceMinutes, n === 0 ? 47 : 45);
  }
  assert.deepEqual(f.state(), before);
});

test('four roles and selected references are scoped freshly, including a legitimate draft record changing its assignment', async t => {
  const f = await fixture(t);
  f.bulk(1, { caseId: f.caseB.id, employeeId: f.employeeB.id });
  const otherOrg = await f.create('organizations', { name: '合成服務報表乙機構' }), otherAdmin = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'FOREIGN' }, otherAdmin);
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMPLOYEE', employeeNo: 'FOREIGN' }, otherAdmin);
  const before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', url(endpoint))).status, 401);
    for (const caller of Object.values(f.clients)) {
      const response = await f.request(caller, 'GET', url(endpoint)); assert.equal(response.status, 200);
      if (endpoint !== endpoints[2]) assert.equal(response.body.total, caller === f.clients.caregiver ? 1 : 2);
      for (const filters of [{ caseId: 'unknown' }, { employeeId: 'not-an-id' }, { caseId: foreignCase.id }, { employeeId: foreignEmployee.id }]) assert.equal((await f.request(caller, 'GET', url(endpoint, filters))).status, 404);
    }
    for (const filters of [{ caseId: f.caseB.id }, { employeeId: f.employeeB.id }]) assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint, filters))).status, 404);
    assert.equal((await f.request(otherAdmin, 'GET', url(endpoint, { caseId: f.caseA.id }))).status, 404);
  }
  assert.deepEqual(f.state(), before);
  const target = await f.create('shifts', { ...f.shiftData, caseId: f.caseB.id, carePlanId: f.planB.id, employeeId: f.employeeB.id, date: '2026-10-09' });
  const blocked = await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shift.id, { version: f.shift.version, employeeId: f.employeeB.id });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'SHIFT_HAS_RECORD');
  const moved = await f.patch('service-records', f.record, { shiftId: target.id, caseId: target.caseId, employeeId: target.employeeId, date: target.date }, f.clients.supervisor);
  assert.equal(moved.version, 2);
  const afterMove = f.state();
  for (const endpoint of endpoints) {
    const own = await f.request(f.clients.caregiver, 'GET', url(endpoint)); assert.equal(own.status, 200);
    if (endpoint !== endpoints[2]) assert.equal(own.body.total, 0);
    assert.ok(!JSON.stringify(own.body).includes(moved.id));
    assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint, { employeeId: f.employeeB.id }))).status, 404);
    const current = await f.request(f.clients.finance, 'GET', url(endpoint, { caseId: f.caseB.id, employeeId: f.employeeB.id, status: 'draft' }));
    assert.equal(current.status, 200); if (endpoint !== endpoints[2]) assert.equal(current.body.rows.find(row => row.recordId === moved.id).version, 2);
  }
  assert.deepEqual(f.state(), afterMove);
});

test('real draft-submit-return-resubmit-approve transitions report current versions without changing immutable prices or legacy APIs', async t => {
  const f = await fixture(t); let item = f.record;
  async function verifyCurrent(status, version, minutes) {
    const before = f.state();
    for (const caller of Object.values(f.clients)) {
      const result = await f.request(caller, 'GET', url(endpoints[1], { status })); assert.equal(result.status, 200);
      assert.equal(result.body.rows[0].version, version); assert.equal(result.body.rows[0].statusLabel, labels[status]);
      assert.deepEqual(result.body.totals, { count: 1, serviceMinutes: minutes });
    }
    assert.deepEqual(f.state(), before);
  }
  await verifyCurrent('draft', 1, 45);
  item = await f.patch('service-records', item, { status: 'submitted', actualEnd: '09:52', note: '合成提交47分鐘' }, f.clients.caregiver);
  await verifyCurrent('submitted', 2, 47);
  let review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + item.id + '/review', { version: item.version, decision: 'returned', reviewNote: '合成退回補充' });
  assert.equal(review.status, 200); item = review.body.item; await verifyCurrent('returned', 3, 47);
  item = await f.patch('service-records', item, { status: 'submitted', note: '合成已補充' }, f.clients.caregiver); await verifyCurrent('submitted', 4, 47);
  review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + item.id + '/review', { version: item.version, decision: 'approved', reviewNote: '合成核閱通過' });
  assert.equal(review.status, 200); await verifyCurrent('approved', 5, 47);
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + item.id)).body.item;
  assert.equal(approved.billingSnapshot.serviceMinutes, 47);
  await f.patch('service-items', f.serviceA, { name: '合成服務目前新名稱', minutes: 120, unitPriceCents: 99999 });
  await f.patch('employees', f.employeeA, { name: '合成人員目前新名稱', hourlyRateCents: 88888 });
  await f.patch('cases', f.caseA, { name: '合成已結案新名稱', status: 'closed' });
  const legacy = new Map();
  for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) legacy.set(kind, (await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body);
  const shiftBefore = await f.request(f.admin, 'GET', url('/api/shift-report/export'));
  const before = f.state();
  const current = await f.request(f.admin, 'GET', url(endpoints[1]));
  assert.equal(current.body.rows[0].serviceMinutes, 47); assert.match(current.body.rows[0].services, /合成服務目前新名稱 × 3/);
  assert.equal(current.body.rows[0].case, '合成已結案新名稱'); assert.equal(current.body.rows[0].reviewNote, '合成核閱通過');
  assert.ok(!JSON.stringify(current.body).includes('billingSnapshot'));
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + item.id)).body.item, approved);
  assert.equal(legacy.get('fees').totals.amountCents, 35000); assert.equal(legacy.get('payroll').totals.amountCents, 18800);
  for (const [kind, old] of legacy) {
    assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body, old);
    for (const path of ['/api/reports/' + kind + '.csv?month=2026-10', '/api/reports/' + kind + '?month=2026-10&format=csv']) assert.equal((await f.request(f.admin, 'GET', path)).body, toCsv(old));
  }
  const shiftAfter = await f.request(f.admin, 'GET', url('/api/shift-report/export'));
  assert.deepEqual({ ...shiftAfter.body, generatedAt: '' }, { ...shiftBefore.body, generatedAt: '' });
  assert.deepEqual((await f.request(f.admin, 'GET', url('/api/shift-report'))).body.rows, shiftBefore.body.rows);
  assert.equal((await f.request(f.admin, 'GET', url('/api/shift-report.csv'))).body, toCsv(shiftBefore.body));
  assert.deepEqual(f.state(), before);
});

test('every matching invalid legacy interval refuses the whole report before pagination and never leaks identifiers in errors', async t => {
  const f = await fixture(t); f.bulk(28);
  const [bad] = f.bulk(1, { caseId: f.caseB.id, employeeId: f.employeeB.id });
  for (const changes of [{ actualStart: undefined }, { actualStart: null }, { actualStart: '24:00' }, { actualStart: '09:00', actualEnd: '09:00' }, { actualStart: '10:00', actualEnd: '09:00' }, { actualStart: '2026-10-21T08:00:00Z' }, { actualEnd: 'not-a-time' }, { date: '2026-02-30' }]) {
    f.overwrite(bad, changes); const before = f.state();
    const filters = { startDate: '2026-01-01', endDate: '2026-12-31' };
    for (const endpoint of endpoints) {
      const response = await f.request(f.admin, 'GET', url(endpoint, filters));
      assert.equal(response.status, 409, JSON.stringify(changes)); assert.equal(response.body.error.code, 'REPORT_DATA_INVALID');
      assert.ok(!Object.hasOwn(response.body, 'rows')); assert.ok(!JSON.stringify(response.body).includes(bad.id)); assert.ok(!JSON.stringify(response.body).includes(f.caseB.id));
    }
    assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1], filters))).status, 200, 'unreadable invalid records never affect own report');
    assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { ...filters, employeeId: f.employeeA.id }))).status, 200, 'nonmatching invalid records do not affect filtered report');
    assert.deepEqual(f.state(), before);
  }
});

test('approved legacy records without billing snapshots remain readable without weakening financial report safeguards', async t => {
  const f = await fixture(t); f.bulk(1, { status: 'approved' }); const before = f.state();
  for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { status: 'approved' }))).status, 200);
  for (const kind of ['fees', 'payroll']) {
    const response = await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10');
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'BILLING_SNAPSHOT_REQUIRED');
  }
  assert.deepEqual(f.state(), before);
});

test('CSV preserves quoted Chinese and formula protection while every role receives only the 15 declared business fields', async t => {
  const f = await fixture(t);
  await f.patch('cases', f.caseA, { name: '=HYPERLINK("https://example.test")', caseNo: '+CASE' });
  await f.patch('employees', f.employeeA, { name: '\t公式人員', employeeNo: '-EMP' });
  await f.patch('service-items', f.serviceA, { code: '@SERVICE', name: '中文"引號"\n服務' });
  const item = await f.patch('service-records', f.record, { status: 'submitted', note: '\n=SUM(1,2)\r\n合成"備註"' }, f.clients.caregiver);
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + item.id + '/review', { version: item.version, decision: 'returned', reviewNote: '-核閱"意見"\n第二行' }); assert.equal(review.status, 200);
  f.bulk(1, { billingSnapshot: { marker: 'PRIVATE-BILLING', hourlyRateCents: 123456 }, address: 'PRIVATE-ADDRESS', phone: 'PRIVATE-PHONE', undeclared: 'PRIVATE-UNKNOWN' });
  const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const full = await f.request(caller, 'GET', url(endpoints[1])); assert.equal(full.status, 200);
    for (const row of full.body.rows) assert.deepEqual(Object.keys(row).sort(), rowKeys.toSorted());
    for (const forbidden of ['PRIVATE-', 'billingSnapshot', 'hourlyRateCents', 'unitPriceCents', 'address', 'phone', 'undeclared']) assert.ok(!JSON.stringify(full.body).includes(forbidden), forbidden);
    const csv = await f.request(caller, 'GET', url(endpoints[2])); assert.equal(csv.body, toCsv(full.body));
    for (const expected of ['"\'=HYPERLINK(""https://example.test"")"', '"\'+CASE"', '"\'-EMP"', '"\'\t公式人員"', '"\'@SERVICE 中文""引號""\n服務 × 3；TEST-S02 合成服務乙 × 1"', '"\'\n=SUM(1,2)\r\n合成""備註"""', '"\'-核閱""意見""\n第二行"']) assert.ok(csv.body.includes(expected), expected);
  }
  assert.deepEqual(f.state(), before);
});

test('unavailable or foreign related names never trigger a cross-organization lookup', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' }), caller = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'PRIVATE-CODE' }, caller);
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMP', employeeNo: 'PRIVATE-EMP' }, caller);
  const foreignService = await f.create('service-items', { name: 'PRIVATE-FOREIGN-SERVICE', code: 'PRIVATE-SERVICE', minutes: 60, unitPriceCents: 99 }, caller);
  const [item] = f.bulk(1, { caseId: foreignCase.id, employeeId: foreignEmployee.id, services: [{ serviceItemId: foreignService.id, quantity: 4 }, { serviceItemId: 'missing', quantity: 2 }] });
  const before = f.state(), result = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(result.status, 200);
  const row = result.body.rows.find(row => row.recordId === item.id);
  assert.equal(row.case, '未取得個案名稱'); assert.equal(row.caseNo, ''); assert.equal(row.employee, '未取得服務人員名稱'); assert.equal(row.employeeNo, '');
  assert.equal(row.services, '未取得服務名稱 × 4；未取得服務名稱 × 2'); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-'));
  assert.deepEqual(f.state(), before);
});

test('1000-record exports are complete and 1001 are refused without restricting list pagination or changing storage', async t => {
  const f = await fixture(t); f.bulk(999); const before = f.state();
  const full = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000); assert.equal(full.body.totals.serviceMinutes, 1044);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2]))).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  f.bulk(1); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const response = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(response.status, 413); assert.equal(response.body.error.code, 'REPORT_TOO_LARGE'); assert.ok(!Object.hasOwn(response.body, 'rows')); }
  const page = await f.request(f.admin, 'GET', url(endpoints[0], { page: '11', pageSize: '100' })); assert.equal(page.status, 200); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1); assert.equal(page.body.totals.serviceMinutes, 1045);
  assert.deepEqual(f.state(), oversized);
});

test('full service JSON is allowed at exactly 2 MiB and both full formats reject one extra UTF-8 byte', async t => {
  const f = await fixture(t), items = f.bulk(249);
  const initial = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(initial.status, 200);
  let remaining = 2 * 1024 * 1024 - initial.bytes.length, last;
  assert.ok(remaining > 0 && remaining < items.length * 10000);
  for (const item of items) {
    const count = Math.min(9999, remaining), note = '字'.repeat(Math.floor(count / 3)) + 'x'.repeat(count % 3);
    f.overwrite(item, { note }); remaining -= Buffer.byteLength(note, 'utf8'); last = { item, note }; if (!remaining) break;
  }
  assert.equal(remaining, 0); const before = f.state();
  const exact = await f.request(f.admin, 'GET', url(endpoints[1])); assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2 * 1024 * 1024);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2]))).status, 200); assert.deepEqual(f.state(), before);
  f.overwrite(last.item, { note: last.note + 'x' }); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); }
  const page = await f.request(f.admin, 'GET', url()); assert.equal(page.status, 200); assert.equal(page.body.total, 250); assert.equal(page.body.rows.length, 25); assert.equal(page.body.totals.serviceMinutes, 294);
  assert.deepEqual(f.state(), oversized);
});
