import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert, saveVersion } from '../src/server/model.mjs';
import { toCsv } from '../src/server/reports.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

const kinds = ['cases', 'shifts', 'services', 'fees', 'payroll'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const password = 'synthetic-legacy-report-month-password';
const ordered = items => items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
const routes = (kind, query = '') => [
  '/api/reports/' + kind + (query ? '?' + query : ''),
  '/api/reports/' + kind + '.csv' + (query ? '?' + query : ''),
  '/api/reports/' + kind + '?' + (query ? query + '&' : '') + 'format=csv',
];

// Malformed values represent synthetic historical imports, inserted with their
// first immutable version. Normal POST/PATCH APIs do not accept these values.
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extra = {}) {
    const headers = { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
    const response = await fetch(base + route, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成舊月份管理者', email: 'admin@legacy-month.example.test', password, organizationName: '合成舊月份甲機構' });
  assert.equal(setup.status, 201);
  const from = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken,
    org: setup.body.organizations[0].id, user: response.body.user });
  const admin = from(setup), clients = { admin };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成舊月份居服甲', employeeNo: 'LM-EA', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成舊月份居服乙', employeeNo: 'LM-EB', hourlyRateCents: 26000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@legacy-month.example.test';
    await create('users', { name: '合成舊月份' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = from(login);
  }
  const caseA = await create('cases', { name: '合成舊月份個案甲', caseNo: 'LM-CA' });
  const caseB = await create('cases', { name: '合成舊月份個案乙', caseNo: 'LM-CB' });
  const service = await create('service-items', { code: 'LM-SERVICE', name: '合成舊月份服務', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: structuredClone(services) });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = extra => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: structuredClone(services), status: 'scheduled', ...extra });
  const shiftA = await create('shifts', shiftData()), shiftB = await create('shifts', shiftData({ caseId: caseB.id, employeeId: employeeB.id, carePlanId: planB.id }));
  const organizationB = await create('organizations', { name: '合成舊月份乙機構' }), foreignAdmin = { ...admin, org: organizationB.id };
  const foreignEmployee = await create('employees', { name: 'SYNTHETIC-FOREIGN-EMPLOYEE', employeeNo: 'LM-FE' }, foreignAdmin);
  const foreignCase = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'LM-FC' }, foreignAdmin);
  const foreignShift = insert(app.db, foreignAdmin.org, 'shifts', shiftData({ caseId: foreignCase.id, employeeId: foreignEmployee.id }));
  const recordData = (shift = shiftA, extra = {}) => ({ shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date,
    actualStart: '09:00', actualEnd: '10:00', services: structuredClone(services), status: 'draft', note: '合成舊月份紀錄', ...extra });
  const snapshot = (amount = 20000, minutes = 60, rate = 24000, employee = employeeA) => ({ capturedAt: '2026-10-08T01:00:00.000Z', currency: 'TWD', trial: true, source: 'approval', serviceMinutes: minutes,
    employee: { id: employee.id, name: employee.name, employeeNo: employee.employeeNo, hourlyRateCents: rate },
    items: [{ serviceItemId: service.id, code: 'LM-SNAPSHOT', name: '合成快照服務', quantity: 2, unitPriceCents: amount / 2, amountCents: amount }] });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() });
  assert.deepEqual(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), tables.slice().sort());
  assert.equal(state().triggers.length, 6);
  async function unchanged(fn) { const before = state(); try { return await fn(); } finally { assert.deepEqual(state(), before, 'GET/rejection batches preserve all eleven raw tables, immutable versions, BLOBs, six triggers and total_changes'); } }
  function imported(entity, data, org = admin.org) {
    const item = insert(app.db, org, entity, structuredClone(data));
    const raw = app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id), versions = app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(item.id);
    assert.equal(raw.version, 1); assert.deepEqual(JSON.parse(raw.data), data); assert.equal(versions.length, 1);
    assert.equal(versions[0].source, 'create'); assert.deepEqual(JSON.parse(versions[0].snapshot), item); return item;
  }
  async function formats(kind, query = '', client = admin) {
    const [jsonRoute, ...csvRoutes] = routes(kind, query), json = await request(client, 'GET', jsonRoute);
    assert.equal(json.status, 200, JSON.stringify(json.body)); assert.equal(json.body.totals.count, json.body.rows.length);
    for (const route of csvRoutes) {
      const csv = await request(client, 'GET', route); assert.equal(csv.status, 200, route + ': ' + JSON.stringify(csv.body));
      assert.equal(csv.body, toCsv(json.body)); assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="' + kind + '.csv"');
      assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.ok(csv.body.endsWith('\r\n'));
      for (const response of [json, csv]) { assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); }
    }
    return json.body;
  }
  return { app, request, create, admin, clients, employeeA, employeeB, caseA, caseB, service, shiftA, shiftB, shiftData, recordData, snapshot, state, unchanged, imported, formats, foreignAdmin, foreignCase, foreignEmployee, foreignShift };
}

test('typed historical dates are excluded from every dated legacy report and all three response formats remain read only', async t => {
  const f = await fixture(t), values = [{ imported: '2026-10-09' }, ['2026-10-09'], 20261009, true, [], {}, 0, false, null, ''];
  const badShifts = values.map(date => f.imported('shifts', f.shiftData({ date, validFrom: '2026-10-01' })));
  const missingShift = f.shiftData({ validFrom: '2026-10-01' }); delete missingShift.date; badShifts.push(f.imported('shifts', missingShift));
  const good = f.imported('service-records', f.recordData(f.shiftA, { status: 'approved', billingSnapshot: f.snapshot() }));
  const badRecords = values.map(date => f.imported('service-records', f.recordData(f.shiftA, { date, validFrom: '2026-10-01', status: 'approved', billingSnapshot: f.snapshot(40000) })));
  const missingRecord = f.recordData(f.shiftA, { validFrom: '2026-10-01', status: 'approved', billingSnapshot: f.snapshot(40000) }); delete missingRecord.date; badRecords.push(f.imported('service-records', missingRecord));
  await f.unchanged(async () => {
    const shifts = await f.formats('shifts', 'month=2026-10');
    assert.deepEqual(shifts.rows.map(row => row.case), ordered([f.shiftA, f.shiftB]).map(row => row.caseId === f.caseA.id ? f.caseA.name : f.caseB.name));
    assert.equal(shifts.rows.length, 2); assert.ok(shifts.rows.every(row => row.date === '2026-10-08'));
    const services = await f.formats('services', 'month=2026-10'); assert.equal(services.rows.length, 1); assert.equal(services.rows[0].date, good.date);
    assert.deepEqual((await f.formats('fees', 'month=2026-10')).totals, { count: 1, amountCents: 20000 });
    assert.deepEqual((await f.formats('payroll', 'month=2026-10')).totals, { count: 1, amountCents: 24000, minutes: 60 });
    assert.equal((await f.formats('cases', 'month=2026-10')).rows.length, 2, 'Valid month never filters the undated case report');
    for (const [entity, items] of [['shifts', badShifts], ['service-records', badRecords]]) for (const item of items) {
      const current = await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id); assert.equal(current.status, 200); assert.deepEqual(current.body.item, item);
      const history = await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history?compare=previous');
      assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.deepEqual(history.body.items[0].snapshot, item);
    }
  });
});

test('absent and empty months preserve imported raw dates, all rows, snapshot totals and original response projections', async t => {
  const f = await fixture(t), dates = [{ imported: 'SYNTHETIC-RAW' }, ['2026-10-09'], 0, false, null, ''];
  const shifts = dates.map(date => f.imported('shifts', f.shiftData({ date, validFrom: '2026-10-01' })));
  const records = dates.map(date => f.imported('service-records', f.recordData(f.shiftA, { date, status: 'approved', billingSnapshot: f.snapshot(2000, 5, 12000) })));
  const missing = f.recordData(f.shiftA, { status: 'approved', billingSnapshot: f.snapshot(2000, 5, 12000) }); delete missing.date; records.push(f.imported('service-records', missing));
  await f.unchanged(async () => {
    for (const kind of kinds) {
      const all = await f.formats(kind);
      for (const query of ['month=', 'month=&month=invalid']) assert.deepEqual(await f.formats(kind, query), all);
      if (kind === 'shifts') assert.deepEqual(all.rows.map(row => row.date), ordered([f.shiftA, f.shiftB, ...shifts]).map(row => row.date));
      if (kind === 'services' || kind === 'fees') assert.deepEqual(all.rows.map(row => Object.hasOwn(row, 'date') ? row.date : undefined), ordered(records).map(row => row.date));
      if (kind === 'fees') assert.deepEqual(all.totals, { count: 7, amountCents: 14000 });
      if (kind === 'payroll') assert.deepEqual(all.rows, [{ employeeNo: f.employeeA.employeeNo, employee: f.employeeA.name, minutes: 35, hourlyRateCents: 12000, amountCents: 7000 }]);
    }
  });
});

test('raw prefix strings, ISO suffixes and year zero retain legacy matching without parsing trimming or validFrom fallback', async t => {
  const f = await fixture(t), matching = ['2026-10', '2026-10-invalid', '2026-10-99', '2026-1001', '2026-10-09T23:59:00-04:00', '2026-10-09 ', '2026-10\nSYNTHETIC'];
  const nonmatching = [' 2026-10-09', '\n2026-10-09', '2026-1-09', '2026-11-01', '0000-02-29'];
  const shifts = matching.map(date => f.imported('shifts', f.shiftData({ date }))), records = matching.map(date => f.imported('service-records', f.recordData(f.shiftA, { date, status: 'approved', billingSnapshot: f.snapshot(3000, 1, 6000) })));
  for (const date of nonmatching) { f.imported('shifts', f.shiftData({ date, validFrom: '2026-10-01' })); f.imported('service-records', f.recordData(f.shiftA, { date, validFrom: '2026-10-01', status: 'approved', billingSnapshot: f.snapshot(99000) })); }
  await f.unchanged(async () => {
    assert.deepEqual((await f.formats('shifts', 'month=2026-10')).rows.map(row => row.date), ordered([...shifts, f.shiftA, f.shiftB]).map(row => row.date));
    assert.deepEqual((await f.formats('services', 'month=2026-10')).rows.map(row => row.date), ordered(records).map(row => row.date));
    assert.deepEqual((await f.formats('fees', 'month=2026-10')).totals, { count: 7, amountCents: 21000 });
    assert.deepEqual((await f.formats('payroll', 'month=2026-10')).totals, { count: 1, amountCents: 700, minutes: 7 });
    for (const kind of ['shifts', 'services', 'fees']) assert.deepEqual((await f.formats(kind, 'month=0000-02')).rows.map(row => row.date), ['0000-02-29']);
    assert.equal((await f.formats('payroll', 'month=0000-02')).totals.minutes, 60);
    for (const kind of kinds) { const empty = await f.formats(kind, 'month=9999-12'); assert.equal(empty.rows.length, kind === 'cases' ? 2 : 0); }
  });
});

test('legacy query validation duplicates ignored parameters and format precedence keep the established contract', async t => {
  const f = await fixture(t); f.imported('shifts', f.shiftData({ date: { imported: 'SYNTHETIC' } }));
  f.imported('service-records', f.recordData(f.shiftA, { status: 'approved', billingSnapshot: f.snapshot() }));
  await f.unchanged(async () => {
    for (const kind of kinds) {
      const original = await f.formats(kind, 'month=2026-10');
      assert.deepEqual(await f.formats(kind, 'month=2026-10&month=invalid'), original);
      assert.deepEqual(await f.formats(kind, 'month=2026-10&page=0&pageSize=0&status=unknown&q=SYNTHETIC&unknown=x'), original);
      for (const month of ['2026-0', '2026-00', '2026-13', '2026-1', ' 2026-10', '2026-10 ', '2026-10-01', '26-10', '0000-00']) for (const route of routes(kind, 'month=' + encodeURIComponent(month))) {
        const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH'); assert.ok(!Object.hasOwn(result.body, 'rows'));
      }
      for (const route of routes(kind, 'month=invalid&month=2026-10')) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH'); }
      const upper = await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10&format=CSV'); assert.equal(upper.status, 200); assert.deepEqual(upper.body, original);
      const duplicate = await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10&format=json&format=csv'); assert.deepEqual(duplicate.body, original);
      const suffix = await f.request(f.admin, 'GET', '/api/reports/' + kind + '.csv?month=2026-10&format=json'); assert.equal(suffix.body, toCsv(original));
    }
  });
});

test('authentication organization roles and unsupported-kind errors precede invalid months and snapshot inspection', async t => {
  const f = await fixture(t); f.imported('service-records', f.recordData(f.shiftA, { date: { imported: 'SYNTHETIC' }, status: 'approved' }));
  await f.unchanged(async () => {
    for (const kind of [...kinds, 'unknown']) for (const route of routes(kind, 'month=invalid')) {
      const anonymous = await f.request(null, 'GET', route); assert.equal(anonymous.status, 401); assert.equal(anonymous.body.error.code, 'AUTH_REQUIRED');
      const missing = await f.request(f.admin, 'GET', route, undefined, { 'X-Org-Id': null }); assert.equal(missing.status, 400); assert.equal(missing.body.error.code, 'ORG_REQUIRED');
      for (const client of Object.values(f.clients)) {
        const outside = await f.request({ ...client, org: 'synthetic-unknown-org' }, 'GET', route); assert.equal(outside.status, 403); assert.equal(outside.body.error.code, 'ORG_FORBIDDEN');
      }
      if (kind === 'unknown') for (const client of Object.values(f.clients)) { const result = await f.request(client, 'GET', route); assert.equal(result.status, 404); assert.equal(result.body.error.code, 'REPORT_NOT_FOUND'); }
      else if (['fees', 'payroll'].includes(kind)) {
        for (const key of ['supervisor', 'caregiver']) { const result = await f.request(f.clients[key], 'GET', route); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN'); }
        for (const key of ['admin', 'finance']) { const result = await f.request(f.clients[key], 'GET', route); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH'); }
      } else for (const client of Object.values(f.clients)) { const result = await f.request(client, 'GET', route); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH'); }
    }
    for (const key of ['supervisor', 'finance', 'caregiver']) { const result = await f.request({ ...f.clients[key], org: f.foreignAdmin.org }, 'GET', '/api/reports/cases?month=invalid'); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ORG_FORBIDDEN'); }
  });
});

test('own-employee and organization projections remain isolated across every service status and three formats', async t => {
  const f = await fixture(t), own = ['draft', 'submitted', 'returned', 'approved'].map((status, i) => f.imported('service-records', f.recordData(f.shiftA, { date: '2026-10-' + (10 + i), status, billingSnapshot: f.snapshot() })));
  const other = f.imported('service-records', f.recordData(f.shiftB, { date: '2026-10-20', status: 'approved', billingSnapshot: f.snapshot(30000, 60, 24000, f.employeeB) }));
  f.imported('service-records', f.recordData(f.shiftA, { date: ['SYNTHETIC-BAD-DATE'], billingSnapshot: f.snapshot() }));
  const foreign = f.imported('service-records', f.recordData(f.foreignShift, { status: 'approved', billingSnapshot: f.snapshot(99900, 60, 24000, f.foreignEmployee) }), f.foreignAdmin.org);
  await f.unchanged(async () => {
    for (const [key, client] of Object.entries(f.clients)) {
      const visible = key === 'caregiver' ? own : [...own, other], result = await f.formats('services', 'month=2026-10', client);
      assert.deepEqual(result.rows.map(row => [row.date, row.status]), ordered(visible).map(row => [row.date, row.status]));
      assert.ok(!JSON.stringify(result).includes('billingSnapshot')); assert.ok(!JSON.stringify(result).includes('SYNTHETIC-FOREIGN'));
      assert.equal((await f.formats('cases', 'month=2026-10', client)).rows.length, key === 'caregiver' ? 1 : 2);
      assert.equal((await f.formats('shifts', 'month=2026-10', client)).rows.length, key === 'caregiver' ? 1 : 2);
      if (key === 'admin' || key === 'finance') assert.equal((await f.formats('fees', 'month=2026-10', client)).totals.amountCents, 50000);
    }
    const foreignResult = await f.formats('services', 'month=2026-10', f.foreignAdmin); assert.equal(foreignResult.rows.length, 1); assert.equal(foreignResult.rows[0].employee, f.foreignEmployee.name);
    assert.equal((await f.formats('fees', 'month=2026-10', f.foreignAdmin)).totals.amountCents, 99900);
    for (const item of [other, foreign]) assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/service-records/' + item.id)).status, 404);
    for (const client of Object.values(f.clients)) assert.equal((await f.request(client, 'GET', '/api/service-records/' + foreign.id + '/history')).status, 404);
  });
});

test('missing approved snapshots still reject selected records while malformed outside dates never enter financial aggregation', async t => {
  const f = await fixture(t); f.imported('service-records', f.recordData(f.shiftA, { status: 'approved', billingSnapshot: f.snapshot() }));
  const outside = [{ imported: '2026-10-08' }, ['2026-10-08'], 0, false, null, '', '2026-11-01'];
  for (const date of outside) f.imported('service-records', f.recordData(f.shiftA, { date, status: 'approved', validFrom: '2026-10-01' }));
  const missingDate = f.recordData(f.shiftA, { status: 'approved', validFrom: '2026-10-01' }); delete missingDate.date; f.imported('service-records', missingDate);
  for (const status of ['draft', 'submitted', 'returned']) f.imported('service-records', f.recordData(f.shiftA, { date: '2026-10-08', status }));
  await f.unchanged(async () => {
    for (const kind of ['fees', 'payroll']) for (const client of [f.admin, f.clients.finance]) {
      assert.equal((await f.formats(kind, 'month=2026-10', client)).rows.length, 1);
      for (const query of ['', 'month=', 'month=2026-11']) for (const route of routes(kind, query)) { const result = await f.request(client, 'GET', route); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BILLING_SNAPSHOT_REQUIRED'); assert.ok(!Object.hasOwn(result.body, 'rows')); }
    }
  });
  const selected = f.imported('service-records', f.recordData(f.shiftA, { date: '2026-10-invalid', status: 'approved' }));
  await f.unchanged(async () => {
    for (const kind of ['fees', 'payroll']) for (const client of [f.admin, f.clients.finance]) for (const route of routes(kind, 'month=2026-10')) {
      const result = await f.request(client, 'GET', route); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BILLING_SNAPSHOT_REQUIRED'); assert.ok(!JSON.stringify(result.body).includes(selected.id));
    }
    assert.equal((await f.formats('services', 'month=2026-10')).rows.length, 5, 'Nonfinancial service report remains readable with a missing selected snapshot');
  });
});

test('real approval freezes fee and payroll values and preserves versions attachments and dedicated report behavior during legacy reads', async t => {
  const f = await fixture(t), submitted = await f.create('service-records', f.recordData(f.shiftA, { status: 'submitted', actualEnd: '09:47' }), f.clients.caregiver);
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成舊月份核閱' }); assert.equal(review.status, 200);
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + submitted.id)).body.item;
  assert.equal(approved.version, 2); assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000);
  const certificate = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成舊月份證照', issuedOn: '2026-01-01' });
  const attachment = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成舊月份PDF', ...filePayload(PDF_BYTES) });
  const certificateAttachment = await f.create('certification-attachments/upload', { certificationId: certificate.id, title: '合成舊月份PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  for (const [entity, item, changes] of [['service-items', f.service, { unitPriceCents: 99999, name: '合成目前新服務' }], ['employees', f.employeeA, { hourlyRateCents: 99999, name: '合成目前新人員' }]]) {
    const changed = await f.request(f.admin, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...changes }); assert.equal(changed.status, 200);
  }
  f.imported('shifts', f.shiftData({ date: { imported: 'SYNTHETIC' } }));
  f.imported('service-records', f.recordData(f.shiftA, { date: ['2026-10-08'], status: 'approved' }));
  await f.unchanged(async () => {
    assert.equal(f.state().tables.attachment_files.length, 1); assert.equal(f.state().tables.certification_attachment_files.length, 1);
    for (const client of [f.admin, f.clients.finance]) {
      const fees = await f.formats('fees', 'month=2026-10', client), payroll = await f.formats('payroll', 'month=2026-10', client);
      assert.equal(fees.rows[0].service, '合成舊月份服務'); assert.deepEqual(fees.totals, { count: 1, amountCents: 20000 });
      assert.equal(payroll.rows[0].employee, '合成舊月份居服甲'); assert.deepEqual(payroll.totals, { count: 1, amountCents: 18800, minutes: 47 });
      for (const report of [fees, payroll]) { assert.match(report.title, /未核定規則/); assert.match(report.note, /不可作正式申報/); assert.match(report.note, /合成測試值/); }
    }
    for (const client of Object.values(f.clients)) {
      assert.equal((await f.formats('services', 'month=2026-10', client)).rows[0].employee, '合成目前新人員');
      const current = await f.request(client, 'GET', '/api/service-records/' + approved.id); assert.equal(current.status, 200);
      assert.equal(Object.hasOwn(current.body.item, 'billingSnapshot'), client === f.admin || client === f.clients.finance);
    }
    assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
    const history = await f.request(f.admin, 'GET', '/api/service-records/' + approved.id + '/history'); assert.equal(history.status, 200); assert.equal(history.body.total, 2); assert.deepEqual(history.body.items[0].snapshot, approved);
    for (const [route, bytes] of [['/api/case-attachments/' + attachment.id + '/download', PDF_BYTES], ['/api/certification-attachments/' + certificateAttachment.id + '/download', PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const result = await f.request(f.admin, 'GET', route + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); }
    for (const suffix of ['', '/export', '.csv']) {
      const result = await f.request(f.admin, 'GET', '/api/service-report' + suffix + '?startDate=2026-10-01&endDate=2026-10-31');
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID');
    }
    const dedicatedShifts = await f.request(f.admin, 'GET', '/api/shift-report/export?startDate=2026-10-01&endDate=2026-10-31');
    assert.equal(dedicatedShifts.status, 200); assert.equal(dedicatedShifts.body.rows.length, 2);
    assert.ok(dedicatedShifts.body.rows.every(row => row.date === '2026-10-08'), 'The dedicated shift report still excludes the nonmatching imported object');
  });
});

test('CSV retains formula neutralization quoted cells raw JSON order and an empty-report header plus note', async t => {
  const f = await fixture(t);
  f.imported('cases', { name: '=SYNTHETIC("quoted")\nsecond line', caseNo: '\tSYNTHETIC,CSV', status: 'active' });
  await f.unchanged(async () => {
    const result = await f.formats('cases', 'month=2026-10'), csv = await f.request(f.admin, 'GET', '/api/reports/cases.csv?month=2026-10');
    assert.equal(result.rows.length, 3); assert.ok(csv.body.includes('"\'\tSYNTHETIC,CSV"')); assert.ok(csv.body.includes('"\'=SYNTHETIC(""quoted"")\nsecond line"'));
    for (const kind of ['shifts', 'services', 'fees', 'payroll']) {
      const empty = await f.formats(kind, 'month=2026-12'); assert.deepEqual(empty.rows, []); assert.equal(empty.totals.count, 0);
      const exported = await f.request(f.admin, 'GET', '/api/reports/' + kind + '.csv?month=2026-12');
      assert.equal(exported.body.split('\r\n').length, 3, 'Empty CSV retains exactly header, note and final CRLF');
      assert.ok(exported.body.includes(empty.note));
    }
  });
});

test('a real inactive caregiver employee blocks every legacy kind before malformed months and restores the same own scope', async t => {
  const f = await fixture(t);
  f.imported('shifts', f.shiftData({ date: ['2026-10-09'] }));
  f.imported('service-records', f.recordData(f.shiftA, { status: 'draft' }));
  f.imported('service-records', f.recordData(f.shiftB, { status: 'approved', billingSnapshot: f.snapshot(30000, 60, 26000, f.employeeB) }));
  const original = await f.unchanged(async () => Object.fromEntries(await Promise.all(['cases', 'shifts', 'services'].map(async kind => [kind, await f.formats(kind, 'month=2026-10', f.clients.caregiver)]))));
  for (const kind of ['cases', 'shifts', 'services']) assert.equal(original[kind].rows.length, 1);
  const inactive = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employeeA.id, { version: f.employeeA.version, status: 'inactive' });
  assert.equal(inactive.status, 200); assert.equal(inactive.body.item.version, 2);
  await f.unchanged(async () => {
    for (const kind of kinds) for (const query of ['month=invalid', 'month=2026-10', 'month=']) for (const route of routes(kind, query)) {
      const response = await f.request(f.clients.caregiver, 'GET', route);
      assert.equal(response.status, 403); assert.equal(response.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); assert.ok(!Object.hasOwn(response.body, 'rows'));
    }
    assert.equal((await f.formats('fees', 'month=2026-10', f.clients.finance)).totals.amountCents, 30000, 'Other valid roles remain available while this caregiver employee is inactive');
  });
  const restored = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employeeA.id, { version: inactive.body.item.version, status: 'active' });
  assert.equal(restored.status, 200); assert.equal(restored.body.item.version, 3);
  await f.unchanged(async () => {
    for (const kind of ['cases', 'shifts', 'services']) assert.deepEqual(await f.formats(kind, 'month=2026-10', f.clients.caregiver), original[kind]);
    for (const kind of ['fees', 'payroll']) for (const route of routes(kind, 'month=invalid')) {
      const response = await f.request(f.clients.caregiver, 'GET', route); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'ROLE_FORBIDDEN');
    }
    const history = await f.request(f.admin, 'GET', '/api/employees/' + f.employeeA.id + '/history');
    assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => [row.version, row.snapshot.status]), [[3, 'active'], [2, 'inactive'], [1, 'active']]);
  });
});

test('legacy shifts preserve source order and raw statuses while payroll groups saved employee rates by first encounter and rounds totals', async t => {
  const f = await fixture(t);
  // Controlled timestamps make the legacy SQL source order explicit. Each
  // synthetic row and first immutable version is INSERTed once, never rewritten.
  function importedAt(entity, data, createdAt) {
    const item = { ...structuredClone(data), id: randomUUID(), orgId: f.admin.org, version: 1, createdAt, updatedAt: createdAt };
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, item.orgId, entity, JSON.stringify(data), 1, createdAt, createdAt);
    saveVersion(f.app.db, item, 'create');
    const raw = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id), version = f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=?').get(item.id);
    assert.deepEqual(JSON.parse(raw.data), data); assert.deepEqual(JSON.parse(version.snapshot), item); return item;
  }
  const shiftSpecs = [
    { date: '2026-10-31', status: 'scheduled', time: '2030-01-01T00:00:04.000Z' },
    { date: '2026-10-01', status: 'completed', time: '2030-01-01T00:00:03.000Z' },
    { date: '2026-10-19', status: 'cancelled', time: '2030-01-01T00:00:02.000Z' },
    { date: '2026-10-imported', status: 'synthetic-legacy-status', time: '2030-01-01T00:00:01.000Z' },
  ];
  for (const row of shiftSpecs) importedAt('shifts', f.shiftData({ date: row.date, status: row.status }), row.time);
  const recordSpecs = [
    { employee: f.employeeB, shift: f.shiftB, rate: 1001, minutes: 1, amount: 100, date: '2026-10-31', time: '2030-02-01T00:00:05.000Z' },
    { employee: f.employeeA, shift: f.shiftA, rate: 3001, minutes: 1, amount: 200, date: '2026-10-01', time: '2030-02-01T00:00:04.000Z' },
    { employee: f.employeeB, shift: f.shiftB, rate: 1001, minutes: 2, amount: 300, date: '2026-10-19', time: '2030-02-01T00:00:03.000Z' },
    { employee: f.employeeA, shift: f.shiftA, rate: 1001, minutes: 1, amount: 400, date: '2026-10-09', time: '2030-02-01T00:00:02.000Z' },
    { employee: f.employeeA, shift: f.shiftA, rate: 3001, minutes: 2, amount: 500, date: '2026-10-imported', time: '2030-02-01T00:00:01.000Z' },
  ];
  for (const row of recordSpecs) {
    const saved = f.snapshot(row.amount, row.minutes, row.rate, row.employee);
    assert.equal(saved.employee.id, row.shift.employeeId); assert.equal(saved.employee.name, row.employee.name); assert.equal(saved.employee.employeeNo, row.employee.employeeNo);
    importedAt('service-records', f.recordData(row.shift, { date: row.date, status: 'approved', billingSnapshot: saved }), row.time);
  }
  f.imported('service-records', f.recordData(f.shiftA, { date: { imported: '2026-10-09' }, status: 'approved', billingSnapshot: f.snapshot(99900, 999, 99999) }));
  await f.unchanged(async () => {
    const shifts = await f.formats('shifts', 'month=2026-10');
    assert.deepEqual(shifts.rows.slice(0, 4).map(row => [row.date, row.status]), shiftSpecs.map(row => [row.date, row.status]));
    assert.equal(shifts.rows.length, 6); assert.deepEqual(shifts.rows.slice(4).map(row => row.status), ['scheduled', 'scheduled']);
    assert.deepEqual((await f.formats('services', 'month=2026-10')).rows.map(row => row.date), recordSpecs.map(row => row.date), 'Legacy report source order remains created_at descending instead of chronological service date');
    const fees = await f.formats('fees', 'month=2026-10'); assert.deepEqual(fees.rows.map(row => row.amountCents), [100, 200, 300, 400, 500]); assert.deepEqual(fees.totals, { count: 5, amountCents: 1500 });
    for (const client of [f.admin, f.clients.finance]) {
      const payroll = await f.formats('payroll', 'month=2026-10', client);
      assert.deepEqual(payroll.rows, [
        { employeeNo: f.employeeB.employeeNo, employee: f.employeeB.name, minutes: 3, hourlyRateCents: 1001, amountCents: 50 },
        { employeeNo: f.employeeA.employeeNo, employee: f.employeeA.name, minutes: 3, hourlyRateCents: 3001, amountCents: 150 },
        { employeeNo: f.employeeA.employeeNo, employee: f.employeeA.name, minutes: 1, hourlyRateCents: 1001, amountCents: 17 },
      ]);
      assert.deepEqual(payroll.totals, { count: 3, amountCents: 217, minutes: 7 });
    }
    assert.deepEqual((await f.formats('services', 'month=2026-10', f.clients.caregiver)).rows.map(row => row.date), ['2026-10-01', '2026-10-09', '2026-10-imported']);
  });
});
