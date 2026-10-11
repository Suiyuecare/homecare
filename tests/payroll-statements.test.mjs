import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { validatePayrollStatement } from '../src/server/payroll-statements.mjs';

const entity = 'payroll-statements', route = item => '/api/' + entity + (item ? '/' + item.id : '');
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const password = 'synthetic-payroll-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成薪資管理員', email: 'payroll-admin@example.test', password, organizationName: '合成人工薪資機構甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  const create = async (kind, data, client = admin, headers = {}) => { const result = await request(client, 'POST', '/api/' + kind, data, headers); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const employee = await create('employees', { name: '合成核定員工', employeeNo: 'PAYROLL-E', hourlyRateCents: 23456 }), second = await create('employees', { name: '合成第二員工', employeeNo: 'PAYROLL-E2', status: 'inactive' });
  const clients = { admin };
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = `payroll-${role}@example.test`; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const org = await create('organizations', { name: '合成人工薪資機構乙' }), foreign = { ...admin, org: org.id };
  const foreignEmployee = await create('employees', { name: '合成跨機構員工', employeeNo: 'PAYROLL-FOREIGN' }, foreign);
  const payload = overrides => ({ employeeId: employee.id, month: '2026-10', number: 'SYNTHETIC-PAYROLL-' + id(), lineItems: [{ label: '人工核定加項', kind: 'earning', amountCents: 5000001 }, { label: '人工核定減項', kind: 'deduction', amountCents: 10000 }], ...overrides });
  const patch = async (item, data, client = admin) => { const response = await request(client, 'PATCH', route(item), { version: item.version, ...data }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item; };
  const counts = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const preserved = () => ({ records: app.db.prepare('SELECT * FROM records WHERE entity<>? ORDER BY id').all(entity), versions: app.db.prepare('SELECT * FROM record_versions WHERE entity<>? ORDER BY record_id,version').all(entity), files: app.db.prepare('SELECT * FROM attachment_files ORDER BY id').all() });
  return { app, request, create, patch, payload, counts, preserved, admin, clients, employee, second, foreign, foreignEmployee };
}

test('manual payroll drafts capture server summary and employee snapshot, edit cents exactly and preserve unrelated records', async t => {
  const f = await fixture(t), before = f.preserved();
  let item = await f.create(entity, f.payload({ number: ' 合成結算編號 ', note: ' 合成多行備註\r\n末行 ', sourceReference: ' 合成人工依據 ', lineItems: [{ label: ' 保持原明細名稱 ', kind: 'earning', amountCents: 5000001 }, { label: '人工核定減項', kind: 'deduction', amountCents: 10000 }] }), f.clients.finance);
  assert.deepEqual(item.summary, { earningCents: 5000001, deductionCents: 10000, netCents: 4990001 }); assert.deepEqual(item.employeeSnapshot, { id: f.employee.id, name: f.employee.name, employeeNo: f.employee.employeeNo });
  assert.equal(item.number, '合成結算編號'); assert.equal(item.note, ' 合成多行備註\r\n末行 '); assert.equal(item.status, 'draft');
  item = await f.patch(item, { note: ' 明確取代\r\n保留結尾 ', lineItems: [{ ...item.lineItems[0], amountCents: 5000002 }, item.lineItems[1]] });
  assert.equal(item.note, ' 明確取代\r\n保留結尾 '); assert.equal(item.lineItems[0].label, ' 保持原明細名稱 ');
  item = await f.patch(item, { lineItems: [{ label: '重複名稱', kind: 'earning', amountCents: 1 }, { label: '重複名稱', kind: 'earning', amountCents: 1 }] }, f.clients.finance);
  assert.equal(item.summary.netCents, 2); assert.equal(item.version, 3); assert.deepEqual(f.preserved(), before);
  const inactive = await f.create(entity, f.payload({ employeeId: f.second.id })); assert.equal(inactive.employeeSnapshot.id, f.second.id, 'former employees can have documented settlements');
});

test('employee name, employee number and current hourly rate changes never rewrite the saved payroll snapshot or manually entered amounts', async t => {
  const f = await fixture(t); let item = await f.create(entity, f.payload({ sourceReference: '合成核定清單' }));
  const changed = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employee.id, { version: f.employee.version, name: '合成改名後', employeeNo: 'PAYROLL-RENAMED', hourlyRateCents: 99999 }); assert.equal(changed.status, 200);
  item = await f.patch(item, { note: '主檔變動後僅更新備註' });
  assert.deepEqual(item.employeeSnapshot, { id: f.employee.id, name: f.employee.name, employeeNo: f.employee.employeeNo }); assert.equal(item.summary.netCents, 4990001);
  item = await f.patch(item, { status: 'reviewed' }); item = await f.patch(item, { status: 'closed' });
  assert.equal(item.status, 'closed'); assert.equal(item.summary.netCents, 4990001); assert.equal(item.employeeSnapshot.name, f.employee.name);
});

test('state machine requires draft creation and review source and locks reviewed/closed/voided content atomically', async t => {
  const f = await fixture(t); let item = await f.create(entity, f.payload()); let before = f.counts();
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, status: 'closed' })).status, 409);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, status: 'reviewed' })).status, 422); assert.deepEqual(f.counts(), before);
  item = await f.patch(item, { status: 'reviewed', sourceReference: '合成薪資核定表' }); before = f.counts();
  for (const fields of [{ note: '覆核後改備註' }, { status: 'draft' }, { status: 'reviewed' }, { status: 'closed', note: '關帳順便改備註' }, { status: 'closed', lineItems: [{ label: '改價', kind: 'earning', amountCents: 1 }] }, { status: 'closed', sourceReference: '另依據' }])
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...fields })).status, 409, JSON.stringify(fields));
  assert.deepEqual(f.counts(), before);
  item = await f.patch(item, { status: 'closed' }); before = f.counts();
  for (const status of ['draft', 'reviewed', 'closed', 'voided']) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status, note: '不可回寫' })).status, 409);
  assert.deepEqual(f.counts(), before);
  for (const status of ['reviewed', 'closed', 'voided']) assert.equal((await f.request(f.admin, 'POST', route(), f.payload({ status, note: '取消原因' }))).status, 422);
});

test('void requires a fresh explicit reason instead of reusing an old note, preserves history and becomes terminal', async t => {
  const f = await fixture(t);
  for (const reviewed of [false, true]) {
    let item = await f.create(entity, f.payload({ note: '這是舊備註而非本次原因', sourceReference: '合成人工核定' })); if (reviewed) item = await f.patch(item, { status: 'reviewed' });
    const before = f.counts();
    for (const note of [undefined, '', ' \n\t ']) {
      const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'voided', ...(note !== undefined ? { note } : {}) }); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'VOID_REASON_REQUIRED');
    }
    assert.deepEqual(f.counts(), before); item = await f.patch(item, { status: 'voided', note: ' 合成本次取消原因 ' }); assert.equal(item.note, ' 合成本次取消原因 ');
    const history = await f.request(f.clients.finance, 'GET', route(item) + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.items[0].snapshot.note, item.note); assert.equal(history.body.items[0].comparison.previousSnapshot.note, '這是舊備註而非本次原因');
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'draft' })).status, 409);
  }
});

test('closed line validation rejects bad amounts/shapes/negative net and derived submissions with zero records/history/audit writes', async t => {
  const f = await fixture(t), before = f.counts(), line = { label: '合成加項', kind: 'earning', amountCents: 1 };
  const invalid = [{ employeeId: f.foreignEmployee.id }, { employeeId: id() }, { month: '0000-01' }, { month: '2026-13' }, { number: ' ' }, { number: '字'.repeat(101) }, { lineItems: [] }, { lineItems: Array(101).fill(line) }, { lineItems: {} }, { lineItems: [{ ...line, amountCents: -1 }] }, { lineItems: [{ ...line, amountCents: 1.1 }] }, { lineItems: [{ ...line, amountCents: '1' }] }, { lineItems: [{ ...line, amountCents: 1e9 + 1 }] }, { lineItems: [{ ...line, amountCents: Number.MAX_SAFE_INTEGER + 1 }] }, { lineItems: [{ ...line, kind: 'tax' }] }, { lineItems: [{ ...line, label: '' }] }, { lineItems: [{ ...line, label: '字'.repeat(101) }] }, { lineItems: [{ ...line, externalAccount: 'no' }] }, { lineItems: [{ label: 'missing', kind: 'earning' }] }, { lineItems: [{ ...line, kind: 'deduction' }] }, { summary: { netCents: 1 } }, { employeeSnapshot: { id: f.employee.id } }, { bankTransfer: true }, { note: '字'.repeat(10001) }, { sourceReference: '字'.repeat(501) }];
  for (const overrides of invalid) assert.equal((await f.request(f.admin, 'POST', route(), f.payload(overrides), { 'Idempotency-Key': id() })).status, 422, JSON.stringify(overrides));
  for (const key of ['employeeId', 'month', 'number', 'lineItems']) { const payload = f.payload(); delete payload[key]; assert.equal((await f.request(f.admin, 'POST', route(), payload)).status, 422); }
  assert.deepEqual(f.counts(), before);
  const maximum = await f.create(entity, f.payload({ lineItems: Array.from({ length: 100 }, (_, index) => ({ label: '合成最大項' + index, kind: 'earning', amountCents: 1e9 })) })); assert.equal(maximum.summary.netCents, 100000000000);
});

test('admin/finance only authorization precedes malformed payload handling and all reads/writes isolate organization and immutable parent identity', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), foreign = await f.create(entity, f.payload({ employeeId: f.foreignEmployee.id }), f.foreign), before = f.counts();
  for (const role of ['supervisor', 'caregiver']) {
    const client = f.clients[role]; for (const path of [route(), route(item), route(item) + '/history?compare=previous']) assert.equal((await f.request(client, 'GET', path)).status, 403);
    assert.equal((await f.request(client, 'POST', route(), [])).status, 403); assert.equal((await f.request(client, 'PATCH', route(item), { bad: true })).status, 403);
  }
  for (const client of [f.admin, f.clients.finance]) {
    assert.equal((await f.request(client, 'GET', route(foreign))).status, 404); assert.equal((await f.request(client, 'GET', route(foreign) + '/history')).status, 404);
    assert.equal((await f.request(client, 'PATCH', route(foreign), { version: 1, note: '跨機構寫入' })).status, 404);
  }
  for (const patch of [{ employeeId: f.second.id }, { month: '2026-11' }, { number: '另一編號' }]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...patch })).status, 409);
  assert.deepEqual(f.counts(), before);
});

test('number uniqueness, same-key retries and competing CAS updates never duplicate statements or rewrite stale contents', async t => {
  const f = await fixture(t), payload = f.payload(), key = 'synthetic-payroll-idem';
  const first = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(first.status, 201); const before = f.counts();
  const retry = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.deepEqual(retry.body, first.body); assert.deepEqual(f.counts(), before);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, note: '不同內容' }, { 'Idempotency-Key': key })).status, 409);
  assert.equal((await f.request(f.admin, 'POST', route(), payload)).status, 409);
  const item = first.body.item, results = await Promise.all(['甲', '乙'].map(note => f.request(f.admin, 'PATCH', route(item), { version: item.version, note })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); const after = f.counts(); assert.equal(after.records, before.records); assert.equal(after.record_versions, before.record_versions + 1); assert.equal(after.audit, before.audit + 1);
});

test('strict employee/month/status/search and history queries paginate and exclude forged same-org or foreign employee snapshots', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload({ note: '合成查詢關鍵字' })); await f.create(entity, f.payload({ employeeId: f.second.id, month: '2026-11' }));
  const list = await f.request(f.clients.finance, 'GET', route() + `?employeeId=${f.employee.id}&month=2026-10&status=draft&q=關鍵字&page=1&pageSize=1`); assert.equal(list.status, 200); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, item.id);
  for (const query of ['month=0000-01', 'month=2026-13', 'status=paid', 'employeeId=', 'q=' + 'x'.repeat(201), 'page=0', 'pageSize=101', 'status=draft&status=closed', 'date=2026-10-10', 'month=2026-10&month=2026-11']) assert.equal((await f.request(f.admin, 'GET', route() + '?' + query)).status, 422, query);
  assert.equal((await f.request(f.admin, 'GET', route(item) + '?status=draft')).status, 422);
  let version = 2;
  for (const changes of [{ employeeId: f.second.id, employeeSnapshot: { id: f.second.id, name: f.second.name, employeeNo: f.second.employeeNo } }, { employeeId: f.foreignEmployee.id }, { month: '2026-11' }, { number: 'FORGED-NUMBER' }])
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, version, JSON.stringify({ ...item, ...changes, version: version++ }), now(), 'synthetic-forged-import');
  const before = f.counts(), history = await f.request(f.clients.finance, 'GET', route(item) + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.equal(history.body.items[0].version, 1); assert.deepEqual(f.counts(), before);
});

test('origin, CSRF and terminal deletes fail without modifying a synthetic payroll record', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.counts();
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'bad-origin' }, { Origin: 'https://synthetic-other.example.test' })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'bad-csrf' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { note: 'no-version' })).status, 422);
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404); assert.deepEqual(f.counts(), before);
});

test('direct payroll validator enforces finance authorization before inspecting data or touching storage', () => {
  for (const role of ['supervisor', 'caregiver']) {
    const fail = (status, code) => { const error = new Error(code); error.status = status; throw error; };
    const touched = () => { throw new Error('unauthorized validator must not access storage'); };
    assert.throws(() => validatePayrollStatement(null, { orgId: 'synthetic-org', role }, entity, null, null, fail, touched, touched, touched), error => error.status === 403 && error.message === 'ROLE_FORBIDDEN');
  }
});

test('payroll current list single history and patch hide foreign or missing parents and mismatched closed employee snapshots', async t => {
  const f = await fixture(t);
  const raw = () => ({ records: f.app.db.prepare('SELECT * FROM records ORDER BY id').all(),
    versions: f.app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(), audit: f.app.db.prepare('SELECT * FROM audit ORDER BY id').all() });
  const variants = [
    { employeeId: f.foreignEmployee.id, employeeSnapshot: { id: f.foreignEmployee.id, name: 'SYNTHETIC-FOREIGN-CURRENT', employeeNo: 'FOREIGN' } },
    { employeeId: id(), employeeSnapshot: { id: 'missing-parent', name: 'SYNTHETIC-MISSING-CURRENT', employeeNo: 'MISSING' } },
    { employeeSnapshot: { id: f.foreignEmployee.id, name: 'SYNTHETIC-FOREIGN-MISMATCH', employeeNo: 'FOREIGN' } },
    { employeeSnapshot: { id: f.second.id, name: 'SYNTHETIC-SAME-ORG-MISMATCH', employeeNo: f.second.employeeNo } },
    { employeeSnapshot: { id: f.employee.id, name: f.employee.name, employeeNo: f.employee.employeeNo, extra: 'SYNTHETIC-CLOSED-SNAPSHOT-EXTRA' } },
    { employeeSnapshot: { id: f.employee.id, name: { private: 'SYNTHETIC-MALFORMED-NAME' }, employeeNo: f.employee.employeeNo } },
  ];
  for (const changed of variants) {
    const item = await f.create(entity, f.payload()), originalData = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...originalData, ...changed }), item.id);
    const before = raw(), counts = f.counts();
    for (const client of [f.admin, f.clients.finance]) {
      const list = await f.request(client, 'GET', route()); assert.equal(list.status, 200); assert.equal(list.body.total, 0);
      const ownFilter = await f.request(client, 'GET', route() + '?employeeId=' + f.employee.id); assert.equal(ownFilter.status, 200); assert.equal(ownFilter.body.total, 0);
      for (const suffix of ['', '/history', '/history?compare=previous']) {
        const result = await f.request(client, 'GET', route(item) + suffix); assert.equal(result.status, 404); assert(!JSON.stringify(result.body).includes('SYNTHETIC-'));
      }
      assert.equal((await f.request(client, 'PATCH', route(item), { version: item.version, note: '不得更正不可見資料' })).status, 404);
    }
    assert.deepEqual(raw(), before); assert.deepEqual(f.counts(), counts);
  }
  assert.equal((await f.request(f.admin, 'GET', route() + '?employeeId=' + f.foreignEmployee.id)).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route() + '?employeeId=' + id())).status, 404);
});

test('payroll history hides invalid snapshot identifiers and closed shapes before comparisons while legitimate snapshots stay available', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload({ note: '合成合法歷程' }));
  let version = 2;
  for (const change of [
    { employeeSnapshot: { id: f.foreignEmployee.id, name: 'SYNTHETIC-FOREIGN-HISTORY', employeeNo: 'FOREIGN' } },
    { employeeSnapshot: { id: f.second.id, name: 'SYNTHETIC-MISMATCH-HISTORY', employeeNo: f.second.employeeNo } },
    { employeeSnapshot: { ...item.employeeSnapshot, extra: 'SYNTHETIC-HISTORY-EXTRA' } },
    { employeeSnapshot: { ...item.employeeSnapshot, name: null } },
    { employeeId: f.foreignEmployee.id, employeeSnapshot: { id: f.foreignEmployee.id, name: 'SYNTHETIC-FOREIGN-PARENT', employeeNo: 'FOREIGN' } },
    { orgId: f.foreign.org }, { id: id() }, { month: '2026-11' }, { number: 'SYNTHETIC-HISTORY-NUMBER' },
  ]) {
    const savedVersion = version++;
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, savedVersion,
      JSON.stringify({ ...item, version: savedVersion, ...change }), now(), 'synthetic-invalid-payroll-history');
  }
  const mismatchedVersion = version++;
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, mismatchedVersion,
    JSON.stringify({ ...item, version: mismatchedVersion + 1, note: 'SYNTHETIC-SQL-VERSION-MISMATCH' }), now(), 'synthetic-invalid-payroll-history');
  const before = f.counts();
  for (const client of [f.admin, f.clients.finance]) {
    const response = await f.request(client, 'GET', route(item) + '/history?compare=previous'); assert.equal(response.status, 200); assert.equal(response.body.total, 1);
    assert.equal(response.body.items[0].version, 1); assert.equal(response.body.items[0].comparison.status, 'initial'); assert.deepEqual(response.body.items[0].snapshot, item);
    assert(!JSON.stringify(response.body).includes('SYNTHETIC-FOREIGN')); assert(!JSON.stringify(response.body).includes('SYNTHETIC-HISTORY-EXTRA'));
  }
  assert.deepEqual(f.counts(), before);
});

test('payroll invalid current SQL version is invisible and cannot acquire an audited replacement version', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  f.app.db.prepare('UPDATE records SET version=0 WHERE id=?').run(item.id); const before = f.counts();
  assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', route(item))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route(item) + '/history?compare=previous')).status, 404);
  // Version zero itself is rejected before storage; a seemingly valid version
  // also cannot repair or expose the hidden record through PATCH.
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 0, note: '無效版本' })).status, 422);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '試圖修復' })).status, 404);
  assert.deepEqual(f.counts(), before);
});
