import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, business } from '../src/server/model.mjs';
import { toCsv, csvCell } from '../src/server/reports.mjs';
import { serializeEmployeeRegions } from '../public/data/employee-regions.js';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const endpoints = ['/api/employee-report', '/api/employee-report/export', '/api/employee-report.csv'];
const url = (endpoint = endpoints[0], filters = {}) => endpoint + '?' + new URLSearchParams(filters);
const keys = ['employeeId', 'version', 'employeeNo', 'name', 'role', 'status', 'statusLabel', 'qualification', 'regions'];
const columns = [['employeeNo', '員工編號'], ['name', '姓名'], ['role', '職務'], ['statusLabel', '員工狀態'], ['qualification', '資格與證照'], ['regions', '服務區域']].map(([key, label]) => ({ key, label, ...(key === 'regions' ? { type: 'employee-regions' } : {}) }));
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
  const password = 'synthetic-employee-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成員工報表管理者', email: 'employee-report-admin@example.test', password, organizationName: '合成員工報表甲機構' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers) {
    const result = await request(caller, 'POST', '/api/' + entity, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, changes, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成 Alpha', employeeNo: 'TEST-ER-A', role: '合成照顧職務', qualification: '保存資格文字', regions: '臺北', phone: 'PRIVATE-PHONE', email: 'private@example.test', note: 'PRIVATE-NOTE', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成 Beta', employeeNo: 'TEST-ER-B', role: '合成督導職務', regions: ['臺南', '', '臺南'], hourlyRateCents: 26000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-ER-I', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@employee-report.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseItem = await create('cases', { name: '合成個案', caseNo: 'TEST-ER-C' });
  let sequence = 0;
  function imported(changes = {}, { version = 1, orgId = admin.org, recordId = id() } = {}) {
    // Explicit synthetic legacy imports in memory, with no rewrite of immutable history.
    const stamp = now(), data = { name: '合成匯入員工', employeeNo: 'TEST-IMPORT-' + String(sequence++).padStart(5, '0'), role: '', qualification: '', status: 'active', regions: '', ...changes };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, 'employees', JSON.stringify(data), version, stamp, stamp);
    return { ...data, id: recordId, orgId, version, createdAt: stamp, updatedAt: stamp };
  }
  const overwrite = (item, changes) => app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), ...changes }), item.id);
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => { const statement = app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'); statement.setReadBigInts(true); return [table, statement.all()]; })),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
  });
  return { app, request, create, patch, admin, clients, employeeA, employeeB, inactive, caseItem, imported, overwrite, state };
}

test('employee reports accept only the date-free strict query contract and preserve exact empty/default echoes', async t => {
  const f = await fixture(t), before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', endpoint)).status, 401);
    const empty = await f.request(f.admin, 'GET', endpoint); assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store'); assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
    if (endpoint !== endpoints[2]) {
      assert.deepEqual(empty.body.filters, { q: '', employeeId: '', status: '' });
      assert.deepEqual(empty.body.selection, { employee: '全部可讀員工', status: '全部狀態' });
      assert.equal(empty.body.page, 1); assert.equal(empty.body.pageSize, endpoint === endpoints[0] ? 25 : 3);
    }
    for (const query of ['startDate=2026-10-01', 'endDate=', 'caseId=', 'supervisorId=', 'month=2026-10', 'format=csv', 'extraFinance=1', 'q=&q=', 'employeeId=&employeeId=', 'status=&status=', 'status=paused', 'status=%20', 'status=__proto__']) {
      assert.equal((await f.request(f.admin, 'GET', endpoint + '?' + query)).status, 422, query);
    }
  }
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e0', 'page=01', 'page=', 'page=9007199254740992', 'pageSize=101', 'pageSize=0', 'pageSize=25.0', 'pageSize=', 'page=1&page=1']) assert.equal((await f.request(f.admin, 'GET', endpoints[0] + '?' + query)).status, 422, query);
  for (const endpoint of endpoints.slice(1)) for (const key of ['page', 'pageSize']) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { [key]: '1' }))).status, 422);
  for (const filters of [{ q: '' }, { employeeId: '' }, { status: '' }, { pageSize: '1' }, { pageSize: '100' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], filters))).status, 200);
  assert.deepEqual(f.state(), before);
});

test('all four real sessions preserve employee scope including inactive staff and own caregiver without shifts', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' });
  const foreign = await f.create('employees', { name: 'PRIVATE-FOREIGN', employeeNo: 'FOREIGN' }, { ...f.admin, org: org.id });
  const before = f.state();
  assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/shifts')).body.total, 0);
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) {
    const result = await f.request(caller, 'GET', endpoint); assert.equal(result.status, 200);
    if (endpoint !== endpoints[2]) {
      assert.equal(result.body.total, caller === f.clients.caregiver ? 1 : 3);
      assert.deepEqual(result.body.rows.map(row => row.employeeId), (caller === f.clients.caregiver ? [f.employeeA] : [f.employeeA, f.employeeB, f.inactive]).map(item => item.id));
    }
    for (const employeeId of [foreign.id, f.caseItem.id, id(), ...(caller === f.clients.caregiver ? [f.employeeB.id, f.inactive.id] : [])]) {
      const denied = await f.request(caller, 'GET', url(endpoint, { employeeId, status: 'inactive', q: 'no-match' }));
      assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied.body).includes(employeeId));
    }
  }
  assert.deepEqual(f.state(), before);
});

test('each fresh request rejects inactive, missing, wrong-entity and foreign caregiver links, then recovers after restoration', async t => {
  const f = await fixture(t), inactive = await f.patch('employees', f.employeeA, { status: 'inactive' });
  let before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', endpoint)).status, 403);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId: inactive.id }))).status, 200);
  }
  assert.deepEqual(f.state(), before);
  await f.patch('employees', inactive, { status: 'active' });
  const org = await f.create('organizations', { name: '合成錯連結機構' }), foreign = await f.create('employees', { name: '合成', employeeNo: 'TEST-FOREIGN' }, { ...f.admin, org: org.id });
  for (const employeeId of [null, id(), f.caseItem.id, foreign.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.caregiver.user.id); before = f.state();
    for (const endpoint of endpoints) { const denied = await f.request(f.clients.caregiver, 'GET', endpoint); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employeeA.id, f.admin.org, f.clients.caregiver.user.id); before = f.state();
  const restored = await f.request(f.clients.caregiver, 'GET', endpoints[1]); assert.equal(restored.body.total, 1); assert.equal(restored.body.rows[0].status, 'active'); assert.equal(restored.body.rows[0].version, 3);
  assert.deepEqual(f.state(), before);
});

test('forty matching employees paginate 25 plus 15 with full union, literal stable sorting and totals beyond the last page', async t => {
  const f = await fixture(t), items = Array.from({ length: 40 }, (_, n) => f.imported({ employeeNo: 'COHORT-' + String(39 - n).padStart(2, '0'), name: '合成四十員工', status: n % 2 ? 'inactive' : 'active' }));
  const before = f.state();
  const first = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-' })), second = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-', page: '2' })), full = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'COHORT-' }));
  assert.equal(first.body.rows.length, 25); assert.equal(second.body.rows.length, 15);
  assert.deepEqual([...first.body.rows, ...second.body.rows], full.body.rows); assert.deepEqual(full.body.rows.map(row => row.employeeId), items.reverse().map(row => row.id));
  for (const result of [first, second, full]) { assert.equal(result.body.total, 40); assert.deepEqual(result.body.totals, { count: 40 }); }
  const beyond = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-', page: '3' })); assert.deepEqual(beyond.body.rows, []); assert.equal(beyond.body.total, 40);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'COHORT-' }))).body, toCsv(full.body));
  const zero = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'MISSING-COHORT' })); assert.equal(zero.body.pageSize, 0); assert.deepEqual(zero.body.rows, []); assert.deepEqual(zero.body.columns, columns); assert.deepEqual(zero.body.totals, { count: 0 });
  assert.deepEqual(f.state(), before);
  const ties = [f.imported({ employeeNo: 'TIE', name: 'B' }, { recordId: 'employee-tie-z' }), f.imported({ employeeNo: 'TIE', name: 'A' }, { recordId: 'employee-tie-y' }), f.imported({ employeeNo: 'TIE', name: 'A' }, { recordId: 'employee-tie-x' })];
  const sorted = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'TIE' })); assert.deepEqual(sorted.body.rows.map(row => row.employeeId), [ties[2], ties[1], ties[0]].map(row => row.id));
});

test('keyword searches only permitted saved fields, never trims or concatenates, and counts UTF-16 units exactly', async t => {
  const f = await fixture(t), source = f.imported({ employeeNo: 'MATCH-NUMBER', name: 'UniqueName', role: 'UniqueRole', qualification: 'UniqueQualification', regions: ['North', 'South', '  space  '], phone: 'PRIVATE-HIDDEN-PHONE', email: 'PRIVATE-HIDDEN-MAIL', note: 'PRIVATE-HIDDEN-NOTE', hourlyRateCents: 987654321, billingSnapshot: { secret: 'PRIVATE-BILLING' } });
  const invalid = f.imported({ employeeNo: 'MALFORMED-REGION', regions: { secret: 'PRIVATE-NESTED' } });
  const before = f.state();
  for (const q of ['match-number', 'UNIQUENAME', 'uniquerole', 'uniquequalification', 'north', 'south', '  space  ', '啟用']) {
    const response = await f.request(f.admin, 'GET', url(endpoints[1], { q, employeeId: source.id })); assert.equal(response.status, 200); assert.equal(response.body.total, 1, q); assert.equal(response.body.filters.q, q);
  }
  for (const q of [' MATCH-NUMBER', 'MATCH-NUMBER ', 'NorthSouth', 'North,South', 'UniqueNameUniqueRole', 'PRIVATE-HIDDEN', '987654321', 'PRIVATE-BILLING', source.id, '保存清單', '[欄位格式無法判讀]', 'PRIVATE-NESTED']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q }))).body.total, 0, q);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'Unique', status: 'inactive' }))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'North', employeeId: invalid.id }))).body.total, 0);
  for (const q of ['x'.repeat(200), '😀'.repeat(100)]) {
    const response = await f.request(f.admin, 'GET', url(endpoints[1], { q })); assert.equal(response.status, 200); assert.equal(response.body.filters.q, q);
  }
  for (const q of ['x'.repeat(201), '😀'.repeat(100) + 'x']) for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q }))).status, 422);
  assert.deepEqual(f.state(), before);
});

test('typed regions preserve marker collisions, empty and ordered values, while malformed imported data exposes no source', async t => {
  const f = await fixture(t), values = [undefined, null, '', [], [''], ['空字串'], '[欄位格式無法判讀]', ['[欄位格式無法判讀]'], '保存清單（1 項）：["臺北"]', '臺北、臺南', ['臺南', ' 臺北 ', '', '臺南'], ['換\n行', '"引號"', '=SUM(1)', '@公式'], { secret: 'PRIVATE-REGIONS' }, ['合法', { secret: 'PRIVATE-REGIONS' }], 99, false];
  const items = values.map((regions, n) => f.imported({ employeeNo: 'REGION-' + String(n).padStart(2, '0'), regions })), before = f.state();
  const result = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'REGION-' })); assert.equal(result.status, 200);
  const actual = result.body.rows.map(row => row.regions);
  assert.deepEqual(actual, [null, null, null, [], [''], ['空字串'], values[6], values[7], values[8], values[9], values[10], values[11], { invalid: true }, { invalid: true }, { invalid: true }, { invalid: true }]);
  const csv = await f.request(f.admin, 'GET', url(endpoints[2], { q: 'REGION-' }));
  assert.equal(csv.body, toCsv(result.body)); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-REGIONS')); assert.ok(!csv.body.includes('PRIVATE-REGIONS'));
  assert.notEqual(serializeEmployeeRegions(actual[4]), serializeEmployeeRegions(actual[5])); assert.notEqual(serializeEmployeeRegions(actual[6]), serializeEmployeeRegions(actual[12]));
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: items[12].id, q: 'PRIVATE-REGIONS' }))).body.total, 0);
  assert.deepEqual(f.state(), before);
});

test('all roles receive exactly nine row keys and six columns without sensitive fields or inferred dates', async t => {
  const f = await fixture(t); f.overwrite(f.employeeA, { fileId: 'PRIVATE-FILE', billingSnapshot: { hourlyRateCents: 77777 }, extraFinance: 'PRIVATE-EXTRA' });
  f.app.db.prepare('UPDATE records SET created_at=?,updated_at=? WHERE id=?').run('INVALID-CREATION-DATE', 'INVALID-UPDATE-DATE', f.employeeA.id);
  const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const result = await f.request(caller, 'GET', url(endpoints[1], { employeeId: f.employeeA.id })); assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['title', 'organization', 'filters', 'selection', 'generatedAt', 'columns', 'rows', 'totals', 'total', 'page', 'pageSize', 'note'].sort());
    assert.deepEqual(result.body.columns, columns); assert.deepEqual(Object.keys(result.body.rows[0]), keys);
    assert.equal(result.body.rows[0].role, f.employeeA.role); assert.equal(result.body.rows[0].statusLabel, '啟用'); assert.equal(result.body.selection.employee, f.employeeA.name);
    const serialized = JSON.stringify(result.body); for (const secret of ['PRIVATE-', 'hourlyRateCents', 'phone', 'email', 'billingSnapshot', 'createdAt', 'updatedAt', 'INVALID-CREATION-DATE', 'INVALID-UPDATE-DATE']) assert.ok(!serialized.includes(secret), secret);
  }
  assert.deepEqual(f.state(), before);
});

test('invalid matching versions and statuses fail the whole result before pagination but filtered records do not block', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 27; n++) f.imported({ employeeNo: 'A-GOOD-' + n, name: 'GOOD-GROUP' });
  const bad = f.imported({ employeeNo: 'ZZ-BAD', name: 'BAD-GROUP', status: 'inactive' });
  for (const version of [0, -1, 1.5, 'not-a-version', Number.MAX_SAFE_INTEGER + 1, -9007199254740992n]) {
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, bad.id); const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', endpoint); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID'); assert.ok(!Object.hasOwn(result.body, 'rows')); assert.ok(!JSON.stringify(result.body).includes(bad.id));
      for (const filter of [{ status: 'active' }, { employeeId: f.employeeA.id }, { q: 'GOOD-GROUP' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', endpoint)).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE records SET version=1 WHERE id=?').run(bad.id);
  for (const status of [undefined, null, '', 'unknown', '__proto__', 1, { secret: 'PRIVATE-STATUS' }]) {
    f.overwrite(bad, { status }); const before = f.state();
    for (const endpoint of endpoints) {
      assert.equal((await f.request(f.admin, 'GET', endpoint)).status, 409);
      for (const filter of [{ status: 'active' }, { q: 'GOOD-GROUP' }, { employeeId: f.employeeA.id }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  const empty = f.imported({ name: { secret: 'PRIVATE-NAME' }, employeeNo: null, role: [], qualification: false });
  const selected = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: empty.id })); assert.equal(selected.status, 200);
  for (const key of ['name', 'employeeNo', 'role', 'qualification']) assert.equal(selected.body.rows[0][key], ''); assert.equal(selected.body.selection.employee, '名稱未取得');
  for (const name of [' \t\n ', '  保留姓名空白  ']) {
    const saved = f.imported({ name }, { version: Number.MAX_SAFE_INTEGER });
    const report = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: saved.id })); assert.equal(report.status, 200);
    assert.equal(report.body.rows[0].name, name); assert.equal(report.body.rows[0].version, Number.MAX_SAFE_INTEGER);
    assert.equal(report.body.selection.employee, name.trim() ? name : '名稱未取得');
  }
  const missingId = f.imported({ name: 'INVALID-ID-GROUP' }, { recordId: '' }); assert.equal(missingId.id, '');
  for (const endpoint of endpoints) { const result = await f.request(f.admin, 'GET', url(endpoint, { q: 'INVALID-ID-GROUP' })); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID'); }
});

test('CSV serializes only the employee-regions type, preserving JSON literals and legacy formula defenses', async t => {
  const f = await fixture(t), values = ['=1+2', '+SUM(1)', '-2', '@SUM(1)', '\t=1', '\r=1', '\n=1', ' \u0001=1', '中文,"引號"\n第二行'];
  const items = values.map((value, n) => f.imported({ employeeNo: 'CSV-' + n, name: value, role: value, qualification: value, regions: n % 2 ? value : [value, '', value] }));
  const before = f.state(), full = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'CSV-' })), result = await f.request(f.admin, 'GET', url(endpoints[2], { q: 'CSV-' }));
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-disposition'), 'attachment; filename="employee-report.csv"'); assert.equal(result.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.deepEqual(result.bytes.subarray(0, 3), Buffer.from([239, 187, 191])); assert.ok(result.body.endsWith('\r\n'));
  assert.equal(result.body, toCsv(full.body));
  for (const [n, value] of values.entries()) { assert.ok(result.body.includes(csvCell(value)), value); assert.ok(result.body.includes(csvCell(serializeEmployeeRegions(items[n].regions)))); }
  const variant = toCsv({ columns: [{ key: 'value', label: '=LABEL', type: 'untrusted-type' }, { key: 'region', label: '區域', type: 'employee-regions' }], rows: [{ value: '=1', region: { secret: '=PRIVATE-SECRET' } }], note: '@NOTE' });
  assert.equal(variant, '\uFEFF' + csvCell('=LABEL') + ',' + csvCell('區域') + '\r\n' + csvCell('=1') + ',' + csvCell('[欄位格式無法判讀]') + '\r\n' + csvCell('@NOTE') + '\r\n');
  assert.ok(!variant.includes('PRIVATE')); assert.deepEqual(f.state(), before);
});

test('real employee edits appear on the next output while CAS, CSRF, idempotency and invalid regions retain original guards', async t => {
  const f = await fixture(t), payload = { name: '合成新建員工', employeeNo: 'TEST-IDEMPOTENT', qualification: '初版', regions: ['臺北'] };
  const created = await f.create('employees', payload, f.admin, { 'Idempotency-Key': 'employee-report-create' });
  const beforeReplay = f.state(), replay = await f.request(f.admin, 'POST', '/api/employees', payload, { 'Idempotency-Key': 'employee-report-create' }); assert.deepEqual(replay.body.item, created); assert.deepEqual(f.state(), beforeReplay);
  const prior = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: created.id })); assert.equal(prior.body.rows[0].version, 1);
  const changed = await f.patch('employees', created, { name: '合成最新姓名', qualification: '最新保存資格', regions: ['臺南', '', '臺南'], status: 'inactive', role: 'admin' }, f.clients.supervisor);
  const before = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', '/api/employees/' + created.id, { version: 1, name: '過時值' })).status, 409);
  assert.equal((await f.request(f.admin, 'PATCH', '/api/employees/' + created.id, { version: 2, name: 'CSRF拒絕' }, { 'X-CSRF-Token': 'é'.repeat(64) })).status, 403);
  for (const caller of [f.clients.finance, f.clients.caregiver]) assert.equal((await f.request(caller, 'PATCH', '/api/employees/' + created.id, { version: 2, name: '拒絕' })).status, 403);
  for (const regions of [1, {}, [null], ['x'.repeat(100)], Array(51).fill(''), 'x'.repeat(1001)]) assert.equal((await f.request(f.admin, 'PATCH', '/api/employees/' + created.id, { version: 2, regions })).status, 422);
  assert.equal((await f.request(f.admin, 'POST', '/api/employees', { ...payload, name: '不同重送' }, { 'Idempotency-Key': 'employee-report-create' })).status, 409);
  for (const endpoint of endpoints) {
    const current = await f.request(f.admin, 'GET', url(endpoint, { employeeId: changed.id })); assert.equal(current.status, 200);
    if (endpoint !== endpoints[2]) { assert.equal(current.body.rows[0].version, 2); assert.equal(current.body.rows[0].name, changed.name); assert.deepEqual(current.body.rows[0].regions, changed.regions); assert.equal(current.body.rows[0].statusLabel, '停用'); }
    else { assert.ok(current.body.includes(changed.name)); assert.ok(!current.body.includes(payload.name)); }
  }
  const history = await f.request(f.admin, 'GET', '/api/employees/' + created.id + '/history?compare=previous'); assert.equal(history.body.total, 2); assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id);
  assert.deepEqual(f.state(), before);
});

test('exactly 1000 employees export completely and row 1001 rejects both full formats without truncating paginated reads', async t => {
  const f = await fixture(t); for (let n = 0; n < 997; n++) f.imported();
  const before = f.state(), full = await f.request(f.admin, 'GET', endpoints[1]); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000); assert.equal(full.body.total, 1000);
  assert.equal((await f.request(f.admin, 'GET', endpoints[2])).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  f.imported(); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', endpoint); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); assert.ok(!Object.hasOwn(result.body, 'rows')); }
  const page = await f.request(f.admin, 'GET', url(endpoints[0], { page: '11', pageSize: '100' })); assert.equal(page.status, 200); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1); assert.deepEqual(f.state(), oversized);
});

test('complete typed JSON permits exactly 2097152 UTF-8 bytes and rejects one extra byte in both full formats', async t => {
  const f = await fixture(t), items = Array.from({ length: 720 }, () => f.imported());
  const initial = await f.request(f.admin, 'GET', endpoints[1]); assert.equal(initial.status, 200);
  let remaining = 2097152 - initial.bytes.length, last;
  for (const item of items) {
    const byteLength = Math.min(2997, remaining + 2), regions = '字'.repeat(Math.floor(byteLength / 3)) + 'x'.repeat(byteLength % 3);
    assert.ok(regions.length <= 1000); f.overwrite(item, { regions }); remaining -= Buffer.byteLength(JSON.stringify(regions)) - Buffer.byteLength('null'); last = { item, regions }; if (!remaining) break;
  }
  assert.equal(remaining, 0); const before = f.state(), exact = await f.request(f.admin, 'GET', endpoints[1]); assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2097152);
  assert.equal((await f.request(f.admin, 'GET', endpoints[2])).status, 200); assert.deepEqual(f.state(), before);
  f.overwrite(last.item, { regions: last.regions + 'x' }); const oversized = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', endpoint); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); }
  const page = await f.request(f.admin, 'GET', endpoints[0]); assert.equal(page.status, 200); assert.equal(page.body.total, 723); assert.equal(page.body.rows.length, 25); assert.deepEqual(f.state(), oversized);
});

test('all employee report exits leave eleven tables, two actual BLOBs, six triggers, approved billing and nineteen previous reports unchanged', async t => {
  const f = await fixture(t), service = await f.create('service-items', { code: 'TEST-ER-SERVICE', name: '合成服務', unitPriceCents: 12345, minutes: 60 });
  const plan = await f.create('care-plans', { caseId: f.caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 30 }] });
  const shift = await f.create('shifts', { caseId: f.caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: f.caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: [{ serviceItemId: service.id, quantity: 3 }], status: 'submitted' }, f.clients.caregiver);
  const approved = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核阅' }); assert.equal(approved.status, 200);
  const snapshot = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item;
  const cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成證照', issuedOn: '2026-01-01' });
  const caseFile = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: f.caseItem.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, 'synthetic.pdf', 'application/pdf') }); assert.equal(caseFile.status, 201);
  const certFile = await f.request(f.admin, 'POST', '/api/certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, 'synthetic.png', 'image/png') }); assert.equal(certFile.status, 201);
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999, name: '合成最新員工姓名' }); await f.patch('service-items', service, { unitPriceCents: 99999 });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  const readReports = async () => {
    const results = {};
    for (const route of routes) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); results[route] = typeof result.body === 'string' ? result.body : { ...result.body, generatedAt: '' }; }
    return results;
  };
  const before = f.state(), oldReports = await readReports(); assert.equal(Object.keys(before.tables).length, 11); assert.equal(before.triggers.length, 6);
  assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) {
    assert.equal((await f.request(caller, 'GET', endpoint)).status, 200);
    assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId: f.employeeA.id, q: '最新', status: 'active' }))).status, 200);
  }
  assert.deepEqual(await readReports(), oldReports);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item, snapshot);
  for (const [entity, result, bytes] of [['case-attachments', caseFile, PDF_BYTES], ['certification-attachments', certFile, PNG_BYTES]]) {
    const download = await f.request(f.admin, 'GET', `/api/${entity}/${result.body.item.id}/download`); assert.equal(download.status, 200); assert.deepEqual(download.bytes, bytes);
  }
  assert.deepEqual(f.state(), before);
});
