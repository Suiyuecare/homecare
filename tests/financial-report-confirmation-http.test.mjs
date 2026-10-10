import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert, saveVersion } from '../src/server/model.mjs';
import { toCsv } from '../src/server/reports.mjs';
import { confirmFinancialReport } from '../public/data/financial-report-confirmation.js';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

const month = '2026-10';
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const kinds = ['fees', 'payroll'];
const routes = (kind, query = 'month=' + month) => ['/api/reports/' + kind + (query ? '?' + query : ''), '/api/reports/' + kind + '.csv' + (query ? '?' + query : ''), '/api/reports/' + kind + '?' + (query ? query + '&' : '') + 'format=csv'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extra = {}) {
    const headers = { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
    const response = await fetch(base + route, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const password = 'synthetic-financial-confirmation-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成試算確認管理者', email: 'admin@financial-confirmation.example.test', password, organizationName: '合成試算確認甲機構' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(entity, data, caller = admin) { const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; }
  async function patch(entity, item, data, caller = admin) { const result = await request(caller, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; }
  const employeeA = await create('employees', { name: '合成快照甲員工', employeeNo: 'FC-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成快照乙員工', employeeNo: 'FC-B', hourlyRateCents: 26000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@financial-confirmation.example.test';
    await create('users', { name: '合成試算確認' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseItem = await create('cases', { name: '合成快照個案', caseNo: 'FC-CASE' });
  const service = await create('service-items', { code: 'FC-SERVICE', name: '合成快照服務', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: structuredClone(services) });
  const shift = await create('shifts', { caseId: caseItem.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: structuredClone(services), status: 'scheduled' });
  const recordData = (changes = {}) => ({ shiftId: shift.id, caseId: caseItem.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:00', actualEnd: '09:47', services: structuredClone(services), status: 'approved', note: '合成試算確認保存紀錄', ...changes });
  const snapshot = (changes = {}) => ({ capturedAt: '2026-10-08T01:00:00.000Z', currency: 'TWD', trial: true, source: 'approval', serviceMinutes: 47,
    employee: { id: employeeA.id, name: employeeA.name, employeeNo: employeeA.employeeNo, hourlyRateCents: 24000 },
    items: [{ serviceItemId: service.id, code: service.code, name: service.name, quantity: 2, unitPriceCents: 10000, amountCents: 20000 }], ...changes });
  function imported(data, org = admin.org, createdAt) {
    let item;
    if (createdAt) {
      item = { ...structuredClone(data), id: randomUUID(), orgId: org, version: 1, createdAt, updatedAt: createdAt };
      app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, org, 'service-records', JSON.stringify(data), 1, createdAt, createdAt); saveVersion(app.db, item, 'create');
    } else item = insert(app.db, org, 'service-records', structuredClone(data));
    const version = app.db.prepare('SELECT * FROM record_versions WHERE record_id=?').all(item.id);
    assert.equal(version.length, 1); assert.equal(version[0].version, 1); assert.equal(version[0].source, 'create'); assert.deepEqual(JSON.parse(version[0].snapshot), item);
    return item;
  }
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() });
  assert.deepEqual(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), tables.slice().sort());
  assert.equal(state().triggers.length, 6);
  async function unchanged(fn) { const before = state(); try { return await fn(); } finally { assert.deepEqual(state(), before, 'Read/rejection batches preserve eleven raw tables, six triggers, immutable versions, BLOBs and total_changes'); } }
  async function confirmed(kind, capturedMonth = month, caller = admin) {
    const query = 'month=' + capturedMonth, result = await request(caller, 'GET', routes(kind, query)[0]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const before = JSON.stringify(result.body); assert.equal(confirmFinancialReport(kind, result.body, capturedMonth), result.body); assert.equal(JSON.stringify(result.body), before);
    assert.deepEqual(Object.keys(result.body), ['title', 'columns', 'rows', 'totals', 'note']);
    for (const route of routes(kind, query).slice(1)) {
      const csv = await request(caller, 'GET', route); assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(result.body));
      assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); assert.ok(csv.body.endsWith('\r\n'));
      assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="' + kind + '.csv"');
      for (const response of [result, csv]) { assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); }
    }
    return result.body;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseItem, service, shift, recordData, snapshot, imported, state, unchanged, confirmed };
}

test('real approved financial responses confirm saved prices rates minutes versions and two attachment BLOBs after master data changes', async t => {
  const f = await fixture(t), submitted = await f.create('service-records', f.recordData({ status: 'submitted' }), f.clients.caregiver);
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成確認核閱' }); assert.equal(review.status, 200);
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + submitted.id)).body.item;
  assert.equal(approved.version, 2); assert.equal(approved.billingSnapshot.serviceMinutes, 47);
  const certificate = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成確認證照', issuedOn: '2026-01-01' });
  const attachment = await f.create('case-attachments/upload', { caseId: f.caseItem.id, title: '合成確認PDF', ...filePayload(PDF_BYTES) });
  const certificateAttachment = await f.create('certification-attachments/upload', { certificationId: certificate.id, title: '合成確認PNG', ...filePayload(PNG_BYTES, '合成確認.png', 'image/png') });
  await f.patch('service-items', f.service, { unitPriceCents: 99999, name: '合成新主檔服務' });
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999, name: '合成新主檔員工' });
  await f.unchanged(async () => {
    assert.equal(f.state().tables.attachment_files.length, 1); assert.equal(f.state().tables.certification_attachment_files.length, 1);
    for (const caller of [f.admin, f.clients.finance]) {
      const fees = await f.confirmed('fees', month, caller), payroll = await f.confirmed('payroll', month, caller);
      assert.deepEqual(fees.rows, [{ date: '2026-10-08', case: f.caseItem.name, serviceCode: 'FC-SERVICE', service: '合成快照服務', quantity: 2, unitPriceCents: 10000, amountCents: 20000 }]);
      assert.deepEqual(fees.totals, { count: 1, amountCents: 20000 });
      assert.deepEqual(payroll.rows, [{ employeeNo: 'FC-A', employee: '合成快照甲員工', minutes: 47, hourlyRateCents: 24000, amountCents: 18800 }]);
      assert.deepEqual(payroll.totals, { count: 1, amountCents: 18800, minutes: 47 });
      assert.match(fees.note, /不可作正式申報/); assert.match(payroll.note, /合成測試值/);
    }
    const current = await f.request(f.admin, 'GET', '/api/service-records/' + approved.id); assert.deepEqual(current.body.item, approved);
    const history = await f.request(f.admin, 'GET', '/api/service-records/' + approved.id + '/history'); assert.equal(history.status, 200); assert.equal(history.body.total, 2); assert.deepEqual(history.body.items[0].snapshot, approved);
    for (const [route, bytes] of [['/api/case-attachments/' + attachment.id + '/download', PDF_BYTES], ['/api/certification-attachments/' + certificateAttachment.id + '/download', PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) {
      const response = await f.request(f.admin, 'GET', route + suffix); assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes);
    }
  });
});

test('legacy prefix dates year zero zero saved prices and repeated visible payroll groups confirm without sorting stricter dates or inferred uniqueness', async t => {
  const f = await fixture(t), dates = ['2026-10-not-a-date', '2026-10-09T23:59:00-04:00', '2026-10', '2026-10'];
  for (const [index, date] of dates.entries()) {
    const employee = index >= 2 ? f.employeeB : f.employeeA;
    const saved = f.snapshot({ serviceMinutes: 1000, employee: { id: employee.id, employeeNo: 'DUPLICATE-VISIBLE', name: '合成相同保存員工', hourlyRateCents: 0 },
      items: [{ serviceItemId: f.service.id, code: '=SYNTHETIC,CSV', name: '合成保存"服務"\n第二行', quantity: 1, unitPriceCents: 0, amountCents: 0 }] });
    f.imported(f.recordData({ date, employeeId: employee.id, billingSnapshot: saved }), f.admin.org, '2030-01-01T00:00:0' + (4 - index) + '.000Z');
  }
  f.imported(f.recordData({ date: '0000-02-29', billingSnapshot: f.snapshot({ employee: { ...f.snapshot().employee, hourlyRateCents: 0 } }) }));
  await f.unchanged(async () => {
    const fees = await f.confirmed('fees'), payroll = await f.confirmed('payroll');
    assert.deepEqual(fees.rows.map(row => row.date), dates); assert.deepEqual(fees.totals, { count: 4, amountCents: 0 });
    assert.deepEqual(payroll.rows, Array.from({ length: 2 }, () => ({ employeeNo: 'DUPLICATE-VISIBLE', employee: '合成相同保存員工', minutes: 2000, hourlyRateCents: 0, amountCents: 0 })));
    assert.deepEqual(payroll.totals, { count: 2, amountCents: 0, minutes: 4000 });
    const csv = await f.request(f.admin, 'GET', '/api/reports/fees.csv?month=' + month); assert.ok(csv.body.includes('"\'=SYNTHETIC,CSV"')); assert.ok(csv.body.includes('"合成保存""服務""\n第二行"'));
    const zeroYear = await f.confirmed('fees', '0000-02'); assert.equal(zeroYear.rows[0].date, '0000-02-29');
    assert.deepEqual((await f.confirmed('payroll', '0000-02')).totals, { count: 1, amountCents: 0, minutes: 47 });
    for (const kind of kinds) { const empty = await f.confirmed(kind, '9999-12'); assert.deepEqual(empty.rows, []); assert.equal(empty.totals.count, 0); assert.equal(empty.totals.amountCents, 0); }
  });
});

test('financial confirmation leaves authorization and organization isolation on the real server across four roles and all three formats', async t => {
  const f = await fixture(t); f.imported(f.recordData({ billingSnapshot: f.snapshot() }));
  const organizationB = await f.create('organizations', { name: '合成試算確認乙機構' }), foreignAdmin = { ...f.admin, org: organizationB.id };
  const foreignEmployee = await f.create('employees', { name: 'SYNTHETIC-FOREIGN-EMPLOYEE', employeeNo: 'FC-FOREIGN', hourlyRateCents: 45000 }, foreignAdmin);
  const foreignCase = await f.create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'FC-FOREIGN-CASE' }, foreignAdmin);
  f.imported(f.recordData({ caseId: foreignCase.id, employeeId: foreignEmployee.id, billingSnapshot: f.snapshot({ employee: { id: foreignEmployee.id, name: foreignEmployee.name, employeeNo: foreignEmployee.employeeNo, hourlyRateCents: 45000 }, items: [{ serviceItemId: f.service.id, code: 'FOREIGN-SAVED', name: 'SYNTHETIC-FOREIGN-SERVICE', quantity: 1, unitPriceCents: 33000, amountCents: 33000 }] }) }), foreignAdmin.org);
  await f.unchanged(async () => {
    for (const kind of kinds) {
      for (const caller of [f.admin, f.clients.finance]) { const own = await f.confirmed(kind, month, caller); assert.equal(own.rows.length, 1); assert.ok(!JSON.stringify(own).includes('SYNTHETIC-FOREIGN')); }
      const foreign = await f.confirmed(kind, month, foreignAdmin); assert.equal(foreign.rows.length, 1); assert.ok(JSON.stringify(foreign).includes('SYNTHETIC-FOREIGN'));
      for (const route of routes(kind)) {
        assert.equal((await f.request(null, 'GET', route)).status, 401);
        assert.equal((await f.request(f.admin, 'GET', route, undefined, { 'X-Org-Id': null })).status, 400);
        for (const caller of [f.clients.supervisor, f.clients.caregiver]) { const response = await f.request(caller, 'GET', route); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'ROLE_FORBIDDEN'); }
        for (const caller of Object.values(f.clients)) { const response = await f.request({ ...caller, org: 'synthetic-unknown-org' }, 'GET', route); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'ORG_FORBIDDEN'); }
        for (const caller of [f.clients.supervisor, f.clients.finance, f.clients.caregiver]) { const response = await f.request({ ...caller, org: foreignAdmin.org }, 'GET', route); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'ORG_FORBIDDEN'); }
      }
    }
  });
  const inactive = await f.patch('employees', f.employeeA, { status: 'inactive' });
  await f.unchanged(async () => {
    for (const kind of kinds) for (const route of routes(kind, 'month=invalid')) { const result = await f.request(f.clients.caregiver, 'GET', route); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.equal((await f.confirmed('fees', month, f.clients.finance)).totals.amountCents, 20000);
  });
  await f.patch('employees', inactive, { status: 'active' });
  await f.unchanged(async () => { for (const kind of kinds) for (const route of routes(kind)) assert.equal((await f.request(f.clients.caregiver, 'GET', route)).body.error.code, 'ROLE_FORBIDDEN'); });
});

test('missing selected approved snapshots retain 409 while outside malformed dates and nonapproved records cannot enter financial totals', async t => {
  const f = await fixture(t); f.imported(f.recordData({ billingSnapshot: f.snapshot() }));
  for (const date of [{ imported: month }, [month], 0, false, null, '', '2026-11-01']) f.imported(f.recordData({ date }));
  for (const status of ['draft', 'submitted', 'returned']) f.imported(f.recordData({ status }));
  await f.unchanged(async () => {
    for (const kind of kinds) for (const caller of [f.admin, f.clients.finance]) {
      assert.equal((await f.confirmed(kind, month, caller)).rows.length, 1);
      for (const route of routes(kind, 'month=2026-11')) { const result = await f.request(caller, 'GET', route); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BILLING_SNAPSHOT_REQUIRED'); assert.equal(Object.hasOwn(result.body, 'rows'), false); }
    }
  });
  f.imported(f.recordData({ date: '2026-10-imported' }));
  await f.unchanged(async () => {
    for (const kind of kinds) for (const caller of [f.admin, f.clients.finance]) for (const route of routes(kind)) {
      const result = await f.request(caller, 'GET', route); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BILLING_SNAPSHOT_REQUIRED'); assert.equal(Object.hasOwn(result.body, 'totals'), false);
    }
    assert.equal((await f.request(f.admin, 'GET', '/api/reports/services?month=' + month)).status, 200, 'Nonfinancial legacy service report still reads missing financial snapshots');
  });
});

test('captured UI confirmation does not change legacy month validation precedence or absent-month raw-data and fresh CSV behavior', async t => {
  const f = await fixture(t); f.imported(f.recordData({ date: { imported: 'SYNTHETIC-RAW-DATE' }, billingSnapshot: f.snapshot() }));
  await f.unchanged(async () => {
    for (const kind of kinds) {
      for (const route of routes(kind, 'month=invalid')) {
        for (const caller of [f.admin, f.clients.finance]) { const result = await f.request(caller, 'GET', route); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_MONTH'); }
        for (const caller of [f.clients.supervisor, f.clients.caregiver]) { const result = await f.request(caller, 'GET', route); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN'); }
      }
      const all = await f.request(f.admin, 'GET', routes(kind, '')[0]); assert.equal(all.status, 200); assert.equal(all.body.rows.length, 1);
      for (const query of ['', 'month=']) for (const route of routes(kind, query).slice(1)) { const csv = await f.request(f.admin, 'GET', route); assert.equal(csv.status, 200); assert.equal(csv.body, toCsv(all.body)); }
      const selected = await f.confirmed(kind); assert.deepEqual(selected.rows, []);
      const duplicate = await f.request(f.admin, 'GET', routes(kind, 'month=' + month + '&month=invalid')[0]); assert.deepEqual(duplicate.body, selected);
      assert.equal(confirmFinancialReport(kind, duplicate.body, month), duplicate.body);
      if (kind === 'fees') { assert.deepEqual(all.body.rows[0].date, { imported: 'SYNTHETIC-RAW-DATE' }); assert.throws(() => confirmFinancialReport(kind, all.body, month), error => error.code === 'REPORT_UNCONFIRMED'); }
      else assert.equal(confirmFinancialReport(kind, all.body, month), all.body, 'Payroll has no date or month echo; its existing server query remains responsible for the requested scope');
    }
    for (const route of routes('unknown', 'month=invalid')) for (const caller of Object.values(f.clients)) { const response = await f.request(caller, 'GET', route); assert.equal(response.status, 404); assert.equal(response.body.error.code, 'REPORT_NOT_FOUND'); }
  });
});
