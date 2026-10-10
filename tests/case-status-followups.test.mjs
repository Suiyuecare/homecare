import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { business, id, now } from '../src/server/model.mjs';

const entity = 'case-status-followups';
const route = (item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
const password = 'synthetic-followups-password';
const fields = ['caseId', 'kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}) {
    const response = await fetch(base + path, {
      method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成追蹤管理員', email: 'followups-admin@example.test', password, organizationName: '合成追蹤機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(kind, data, client = admin, headers = {}) {
    const result = await request(client, 'POST', '/api/' + kind, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(item, data, client = admin) {
    const result = await request(client, 'PATCH', route(item), { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成追蹤居服員', employeeNo: 'SF-EMP', hourlyRateCents: 12345 });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = `followups-${role}@example.test`;
    await create('users', { name: '合成追蹤' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password });
    assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成可讀追蹤個案', caseNo: 'SF-CASE-A', contactName: '合成原聯絡人', note: '合成原主檔注意事項' });
  const caseB = await create('cases', { name: '合成未派班追蹤個案', caseNo: 'SF-CASE-B' });
  const payload = overrides => ({ caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', reason: '合成暫停原因', ...overrides });
  function counts() { return Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n])); }
  function changes() { return app.db.prepare('SELECT total_changes() AS n').get().n; }
  function preserved() {
    return {
      records: app.db.prepare('SELECT * FROM records WHERE entity<>? ORDER BY id').all(entity),
      versions: app.db.prepare('SELECT * FROM record_versions WHERE entity<>? ORDER BY record_id,version').all(entity),
      caseFiles: app.db.prepare('SELECT * FROM attachment_files ORDER BY id').all(),
      certificationFiles: app.db.prepare('SELECT * FROM certification_attachment_files ORDER BY id').all(),
    };
  }
  async function assign({ approved = false, cancelled = false } = {}) {
    const service = await create('service-items', { code: 'SF-SERVICE', name: '合成快照服務', minutes: 60, unitPriceCents: 8765 });
    const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 3 }] });
    let shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }] });
    let record;
    if (approved) {
      record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:55', services: shift.services, status: 'submitted' });
      const response = await request(clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核閱' });
      assert.equal(response.status, 200);
      record = (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
      shift = (await request(admin, 'GET', '/api/shifts/' + shift.id)).body.item;
    } else if (cancelled) {
      const response = await request(admin, 'PATCH', '/api/shifts/' + shift.id, { version: shift.version, status: 'cancelled' });
      assert.equal(response.status, 200); shift = response.body.item;
    }
    return { service, plan, shift, record };
  }
  async function foreignFixture() {
    const org = await create('organizations', { name: '合成追蹤機構乙' });
    const client = { ...admin, org: org.id };
    const caseItem = await create('cases', { name: '合成跨機構個案', caseNo: 'SF-FOREIGN' }, client);
    const item = await create(entity, payload({ caseId: caseItem.id, reason: 'SYNTHETIC-FOREIGN-REASON' }), client);
    return { client, caseItem, item };
  }
  return { app, base, request, create, patch, admin, clients, employee, caseA, caseB, payload, counts, changes, preserved, assign, foreignFixture };
}

test('manual follow-ups preserve nine fields, trim supplied strings and keep optional defaults and independent duplicates', async t => {
  const f = await fixture(t);
  const original = f.preserved();
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 11);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n, 6);
  let item = await f.create(entity, f.payload({ caseId: ' ' + f.caseA.id + ' ', kind: ' pause ', startDate: ' 2026-10-01 ', endDate: ' 2026-10-03 ', reason: ' 合成多行原因\n第二行 ', followUpDate: ' 2026-09-01 ', outcome: ' 合成處理结果 ', note: ' 合成備註 ', status: ' pending ' }), f.clients.supervisor);
  assert.deepEqual(Object.keys(business(item)).sort(), [...fields].sort());
  for (const key of fields) assert.equal(item[key], item[key].trim());
  assert.equal(item.reason, '合成多行原因\n第二行'); assert.equal(item.followUpDate, '2026-09-01', 'follow-up date is not constrained to the documentary service interval');
  const defaultItem = await f.create(entity, f.payload());
  assert.deepEqual(business(defaultItem), { status: 'pending', endDate: '', followUpDate: '', outcome: '', note: '', ...f.payload() });
  const another = await f.create(entity, f.payload()); assert.notEqual(another.id, defaultItem.id);
  item = await f.patch(item, { kind: 'closure', status: 'completed', endDate: ' \t ', followUpDate: '', outcome: '', note: ' 明確更新 ' });
  assert.equal(item.status, 'completed'); assert.equal(item.kind, 'closure'); assert.equal(item.endDate, ''); assert.equal(item.note, '明確更新');
  assert.deepEqual(f.preserved(), original); assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404);
});

test('input guards reject unknown fields, wrong types, impossible dates, reversed intervals and immutable same-org parents atomically', async t => {
  const f = await fixture(t), foreign = await f.foreignFixture();
  const item = await f.create(entity, f.payload());
  const before = f.counts();
  const invalid = [
    { caseId: '' }, { caseId: '  ' }, { caseId: id() }, { caseId: foreign.caseItem.id }, { caseId: f.employee.id },
    { kind: '' }, { kind: 'closed' }, { kind: 'Pause' }, { status: '' }, { status: 'active' },
    { startDate: '' }, { startDate: '2026-02-29' }, { startDate: '2026-1-01' }, { startDate: '2026-10-01T00:00:00Z' },
    { endDate: '2026-09-30' }, { endDate: '2026-13-01' }, { followUpDate: '2026-02-30' },
    { reason: '' }, { reason: '\t\n ' }, { outcome: '字'.repeat(501) }, { note: '字'.repeat(10001) }, { reason: '字'.repeat(10001) },
    { automaticCancel: true }, { billingSnapshot: {} }, { employeeId: f.employee.id },
  ];
  for (const key of fields) for (const value of [null, 1, [], {}]) invalid.push({ [key]: value });
  for (const data of invalid) {
    const result = await f.request(f.admin, 'POST', route(), f.payload(data));
    assert.equal(result.status, 422, JSON.stringify(data));
  }
  for (const caseId of [f.caseB.id, foreign.caseItem.id, id(), '']) {
    const response = await f.request(f.admin, 'PATCH', route(item), { version: item.version, caseId });
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'CASE_IMMUTABLE');
  }
  for (const key of ['caseId', 'kind', 'startDate', 'reason']) { const data = f.payload(); delete data[key]; assert.equal((await f.request(f.admin, 'POST', route(), data)).status, 422, 'required ' + key); }
  for (const data of [[], null]) assert.equal((await f.request(f.admin, 'POST', route(), data)).status, 400);
  assert.equal((await f.request(f.admin, 'POST', route(), f.payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item))).body.item, item);
});

test('valid date and text boundaries are exact and no statutory completion outcome is invented', async t => {
  const f = await fixture(t);
  for (const startDate of ['0000-01-01', '2024-02-29', '9999-12-31']) {
    const item = await f.create(entity, f.payload({ startDate, endDate: startDate, reason: '字'.repeat(10000), note: '字'.repeat(10000), outcome: '字'.repeat(500), status: 'completed' }));
    assert.equal(item.startDate, startDate); assert.equal(item.reason.length, 10000); assert.equal(item.outcome.length, 500);
  }
  const item = await f.create(entity, f.payload({ status: 'completed' })); assert.equal(item.outcome, '', 'manual status carries no unapproved completion criterion');
});

test('four actual roles respect current readable parent and organization scopes, including cancelled own shifts and terminal follow-ups', async t => {
  const f = await fixture(t); await f.assign({ cancelled: true });
  const own = await f.create(entity, f.payload());
  const completed = await f.create(entity, f.payload({ kind: 'closure', status: 'completed' }));
  const cancelled = await f.create(entity, f.payload({ status: 'cancelled' }));
  const hidden = await f.create(entity, f.payload({ caseId: f.caseB.id, reason: 'SYNTHETIC-HIDDEN-REASON' }));
  const foreign = await f.foreignFixture();
  const before = f.counts(), changeCount = f.changes();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) {
    assert.equal((await f.request(client, 'GET', route())).body.total, 4);
    assert.equal((await f.request(client, 'GET', route(hidden))).status, 200);
    assert.equal((await f.request(client, 'GET', route(hidden, '/history?compare=previous'))).status, 200);
  }
  const carer = f.clients.caregiver;
  const list = await f.request(carer, 'GET', route());
  assert.deepEqual(new Set(list.body.items.map(x => x.id)), new Set([own.id, completed.id, cancelled.id]));
  assert(!JSON.stringify(list.body).includes('SYNTHETIC-HIDDEN'));
  for (const item of [hidden, foreign.item, { id: id() }]) for (const suffix of ['', '/history', '/history?compare=previous']) assert.equal((await f.request(carer, 'GET', route(item, suffix))).status, 404);
  for (const client of [carer, f.clients.finance]) for (const item of [own, hidden, foreign.item, { id: id() }]) {
    assert.equal((await f.request(client, 'PATCH', route(item), {})).status, 403);
    assert.equal((await f.request(client, 'DELETE', route(item))).status, 403);
  }
  for (const client of [carer, f.clients.finance]) assert.equal((await f.request(client, 'POST', route(), {})).status, 403, 'role guard precedes payload validation');
  assert.equal((await f.request(f.admin, 'GET', route(foreign.item))).status, 404);
  assert.equal((await f.request(foreign.client, 'GET', route(own))).status, 404);
  assert.equal((await f.request(carer, 'GET', route(), undefined, { 'X-Org-Id': foreign.client.org })).status, 403);
  for (const caseId of [f.caseB.id, foreign.caseItem.id, id()]) assert.equal((await f.request(carer, 'GET', route(null, '?caseId=' + caseId))).body.total, 0);
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
});

test('CSRF, Origin, authentication and active caregiver linkage remain server enforced without failed-write side effects', async t => {
  const f = await fixture(t); await f.assign();
  const item = await f.create(entity, f.payload());
  const before = f.counts();
  assert.equal((await f.request(null, 'GET', route())).status, 401);
  for (const method of ['POST', 'PATCH']) {
    const path = method === 'POST' ? route() : route(item), data = method === 'POST' ? f.payload() : { version: item.version, note: '不可保存' };
    assert.equal((await f.request(f.admin, method, path, data, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request(f.admin, method, path, data, { Origin: 'https://synthetic-other.example.test' })).status, 403);
  }
  assert.deepEqual(f.counts(), before);
  const disabled = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employee.id, { version: f.employee.version, status: 'inactive' }); assert.equal(disabled.status, 200);
  const afterDisabled = f.counts();
  for (const suffix of ['', '/' + item.id, '/' + item.id + '/history?compare=previous']) {
    const result = await f.request(f.clients.caregiver, 'GET', '/api/' + entity + suffix); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  }
  assert.deepEqual(f.counts(), afterDisabled);
});

test('strict six-key query rejects duplicates, unknown keys and invalid values on lists and single reads', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  const invalid = [
    'month=2026-10', 'date=2026-10-01', 'employeeId=' + f.employee.id, 'compare=previous', 'unexpected=x',
    'kind=', 'kind=paused', 'status=', 'status=active', 'caseId=', 'caseId=%20%09', 'caseId=' + 'x'.repeat(501), 'q=' + 'x'.repeat(201),
    'page=-1', 'page=1.1', 'page=abc', 'pageSize=0', 'pageSize=101', 'pageSize=1.5',
  ];
  for (const key of ['page', 'pageSize', 'q', 'caseId', 'kind', 'status']) invalid.push(`${key}=x&${key}=x`);
  const before = f.counts(), changeCount = f.changes();
  for (const query of invalid) for (const target of [null, item]) assert.equal((await f.request(f.admin, 'GET', route(target, '?' + query))).status, 422, query);
  for (const target of [null, item]) assert.equal((await f.request(f.admin, 'GET', route(target, '?caseId=' + f.caseA.id + '&kind=pause&status=pending&q=&page=1&pageSize=25'))).status, 200);
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
});

test('query filters and case scopes precede stable server pagination with default 25 and exact 100 maximum', async t => {
  const f = await fixture(t); await f.assign();
  const created = [];
  for (let index = 0; index < 28; index++) created.push(await f.create(entity, f.payload({ reason: '合成分頁共同原因 ' + index, kind: index < 26 ? 'pause' : 'closure', status: index < 25 ? 'pending' : 'completed' })));
  await f.create(entity, f.payload({ caseId: f.caseB.id, reason: '合成分頁共同原因他案' }));
  const query = '?caseId=' + f.caseA.id + '&q=' + encodeURIComponent('合成分頁共同原因');
  const before = f.counts(), changeCount = f.changes();
  const first = (await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=1'))).body;
  const second = (await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=2'))).body;
  assert.equal(first.total, 28); assert.equal(first.pageSize, 25); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual(new Set([...first.items, ...second.items].map(x => x.id)), new Set(created.map(x => x.id)));
  assert.deepEqual((await f.request(f.admin, 'GET', route(null, query + '&page=1'))).body.items, first.items);
  const selected = (await f.request(f.admin, 'GET', route(null, query + '&kind=pause&status=completed'))).body;
  assert.equal(selected.total, 1); assert.equal(selected.items[0].reason, '合成分頁共同原因 25');
  assert.equal((await f.request(f.clients.caregiver, 'GET', route(null, query + '&pageSize=100&kind=closure'))).body.total, 2);
  assert.equal((await f.request(f.admin, 'GET', route(null, '?q=synthetic-nonexistent'))).body.total, 0);
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
});

test('idempotent POST and versioned PATCH commit child, history and audit atomically and preserve unrelated original data', async t => {
  const f = await fixture(t); const assigned = await f.assign({ approved: true });
  assert(assigned.record.billingSnapshot);
  const pdfBytes = Buffer.from('%PDF-1.4\nSynthetic followup fixture\n%%EOF');
  await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成個案附件保留', fileName: '合成原附件.pdf', mimeType: 'application/pdf', contentBase64: pdfBytes.toString('base64') });
  const certification = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照保留', issuedOn: '2026-01-01' });
  await f.create('certification-attachments/upload', { certificationId: certification.id, title: '合成證照附件保留', fileName: '合成證照附件.pdf', mimeType: 'application/pdf', contentBase64: pdfBytes.toString('base64') });
  const original = f.preserved();
  assert.equal(original.caseFiles.length, 1); assert.equal(original.certificationFiles.length, 1);
  assert.deepEqual(Buffer.from(original.caseFiles[0].content), pdfBytes); assert.deepEqual(Buffer.from(original.certificationFiles[0].content), pdfBytes);
  const headers = { 'Idempotency-Key': 'synthetic-followup-once' }, payload = f.payload();
  const before = f.counts();
  const one = await f.request(f.admin, 'POST', route(), payload, headers);
  assert.equal(one.status, 201); const item = one.body.item, after = f.counts();
  for (const key of ['records', 'record_versions', 'audit', 'idempotency']) assert.equal(after[key], before[key] + 1);
  const retry = await f.request(f.admin, 'POST', route(), payload, headers);
  assert.equal(retry.status, 201); assert.deepEqual(retry.body, one.body); assert.deepEqual(f.counts(), after);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, reason: 'different' }, headers)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  for (const version of [undefined, 0, '1', 1.2]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version, note: 'invalid' })).status, 422);
  const updated = await f.patch(item, { note: '合成追蹤處理', status: 'completed' }, f.clients.supervisor);
  const latest = f.counts(); assert.equal(latest.records, after.records); assert.equal(latest.record_versions, after.record_versions + 1); assert.equal(latest.audit, after.audit + 1); assert.equal(latest.idempotency, after.idempotency);
  const stale = await f.request(f.admin, 'PATCH', route(item), { version: item.version, reason: '過時原因' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(f.counts(), latest); assert.deepEqual(f.preserved(), original);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + assigned.record.id)).body.item.billingSnapshot, assigned.record.billingSnapshot);
  assert.equal(updated.version, 2);
});

test('unsubmitted saved fields retain raw values when PATCH supplies only one trimmed replacement', async t => {
  const f = await fixture(t);
  const recordId = id(), time = now();
  const data = { ...f.payload(), endDate: '', followUpDate: '', outcome: ' 合成原結果\n ', note: ' 合成原備註\n ', status: 'pending' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, entity, JSON.stringify(data), 1, time, time);
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, recordId, 1, JSON.stringify({ ...data, id: recordId, orgId: f.admin.org, version: 1, createdAt: time, updatedAt: time }), time, 'baseline');
  const updated = await f.patch({ id: recordId, version: 1 }, { reason: ' 明確新原因 ' });
  assert.equal(updated.reason, '明確新原因'); assert.equal(updated.note, data.note); assert.equal(updated.outcome, data.outcome);
  const history = (await f.request(f.admin, 'GET', route(updated, '/history?compare=previous'))).body;
  assert.equal(history.items[0].comparison.previousSnapshot.note, data.note); assert.equal(history.items[0].snapshot.note, data.note);
});

test('merged saved whitespace-only reason rejects unrelated PATCH atomically without trimming meaningful saved CR text', async t => {
  const f = await fixture(t);
  const imported = reason => {
    const recordId = id(), time = now();
    const data = { ...f.payload({ reason }), endDate: '', followUpDate: '', outcome: '', note: ' 合成原備註 ', status: 'pending' };
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, entity, JSON.stringify(data), 1, time, time);
    const item = { ...data, id: recordId, orgId: f.admin.org, version: 1, createdAt: time, updatedAt: time };
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, recordId, 1, JSON.stringify(item), time, 'baseline');
    return item;
  };
  for (const reason of ['   ', ' \t\r\n　 ']) {
    const item = imported(reason), before = f.counts(), changeCount = f.changes();
    const rawRecord = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id);
    const rawVersions = f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(item.id);
    const response = await f.request(f.admin, 'PATCH', route(item), { version: item.version, note: '只更新備註' });
    assert.equal(response.status, 422); assert.equal(response.body.error.code, 'REQUIRED'); assert(Object.hasOwn(response.body.error.fields, 'reason'));
    assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
    assert.deepEqual(f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id), rawRecord);
    assert.deepEqual(f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(item.id), rawVersions);
    assert.deepEqual((await f.request(f.admin, 'GET', route(item))).body.item, item);
  }
  const item = imported(' \r合成真正原因\r\n ');
  const updated = await f.patch(item, { note: ' 明確新備註 ' });
  assert.equal(updated.note, '明確新備註'); assert.equal(updated.reason, item.reason);
  const history = (await f.request(f.admin, 'GET', route(updated, '/history?compare=previous'))).body;
  assert.equal(history.items[0].snapshot.reason, item.reason); assert.equal(history.items[0].comparison.previousSnapshot.reason, item.reason);
});

test('raw and compared histories use actual actors, exact previous versions across pages and no read mutations', async t => {
  const f = await fixture(t); await f.assign();
  let item = await f.create(entity, f.payload());
  for (let version = 2; version <= 28; version++) item = await f.patch(item, { note: '合成追蹤第' + version + '版', status: version % 2 ? 'pending' : 'completed' }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.counts(), changeCount = f.changes();
  const first = (await f.request(f.clients.caregiver, 'GET', route(item, '/history?compare=previous&page=1'))).body;
  const second = (await f.request(f.clients.finance, 'GET', route(item, '/history?compare=previous&page=2'))).body;
  assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual(first.items[0].actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
  assert.equal(first.items[0].comparison.previousVersion, 27);
  assert.deepEqual(first.items.at(-1).comparison.previousSnapshot, second.items[0].snapshot);
  assert.deepEqual(second.items.at(-1).actor, { id: f.admin.user.id, name: f.admin.user.name });
  assert.deepEqual(second.items.at(-1).comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
  const plain = (await f.request(f.admin, 'GET', route(item, '/history'))).body;
  assert(plain.items.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
  for (const query of ['compare=', 'compare=next', 'compare=previous&compare=previous', 'page=0', 'pageSize=101']) assert.equal((await f.request(f.admin, 'GET', route(item, '/history?' + query))).status, 422);
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
});

test('all roles hide poisoned saved-parent versions before exact previous comparison, preserve gaps and do not infer actors', async t => {
  const f = await fixture(t); await f.assign(); const foreign = await f.foreignFixture();
  const recordId = id(), time = now();
  const data = { ...f.payload(), endDate: '', followUpDate: '', outcome: '', note: '合成基準第5版', status: 'pending' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, entity, JSON.stringify(data), 5, time, time);
  for (const version of [1, 2, 3, 4, 5]) {
    const caseId = version === 2 ? f.caseB.id : version === 3 ? foreign.caseItem.id : version === 4 ? id() : f.caseA.id;
    const snapshot = { ...data, caseId, reason: version >= 2 && version <= 4 ? 'SYNTHETIC-POISONED-SAVED-PARENT' : data.reason, id: recordId, orgId: f.admin.org, version, createdAt: time, updatedAt: time };
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, recordId, version, JSON.stringify(snapshot), time, 'baseline');
  }
  const item = { id: recordId, version: 5 }, before = f.counts(), changeCount = f.changes();
  for (const client of Object.values(f.clients)) for (const suffix of ['/history', '/history?compare=previous']) {
    const response = await f.request(client, 'GET', route(item, suffix)); assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(row => row.version), [5, 1]);
    assert(!JSON.stringify(response.body).includes('SYNTHETIC-POISONED-SAVED-PARENT'));
    if (suffix.includes('?')) { assert.equal(response.body.items[0].actor, null); assert.deepEqual(response.body.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); }
  }
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
  const updated = await f.patch(item, { note: '合法第6版' });
  const row = (await f.request(f.clients.caregiver, 'GET', route(updated, '/history?compare=previous'))).body.items[0];
  assert.equal(row.comparison.previousVersion, 5); assert.equal(row.comparison.status, 'available'); assert.equal(row.actor.id, f.admin.user.id);
});

test('parent status changes retain follow-ups and missing or wrong-entity parents never become readable', async t => {
  const f = await fixture(t); await f.assign();
  const item = await f.create(entity, f.payload());
  let caseItem = f.caseA;
  for (const status of ['paused', 'closed', 'active']) {
    const changed = await f.request(f.admin, 'PATCH', '/api/cases/' + caseItem.id, { version: caseItem.version, status }); assert.equal(changed.status, 200); caseItem = changed.body.item;
    assert.deepEqual((await f.request(f.clients.caregiver, 'GET', route(item))).body.item, item);
    assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).body.total, 1);
  }
  for (const caseId of [id(), f.employee.id]) {
    const recordId = id(), time = now(), data = { ...business(item), caseId, reason: 'SYNTHETIC-MISSING-PARENT' };
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, entity, JSON.stringify(data), 1, time, time);
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, recordId, 1, JSON.stringify({ ...data, id: recordId, orgId: f.admin.org, version: 1, createdAt: time, updatedAt: time }), time, 'baseline');
    for (const client of Object.values(f.clients)) for (const suffix of ['', '/history', '/history?compare=previous']) assert.equal((await f.request(client, 'GET', route({ id: recordId }, suffix))).status, 404);
  }
  const before = f.counts(), changeCount = f.changes();
  for (const client of Object.values(f.clients)) { const result = await f.request(client, 'GET', route()); assert.equal(result.body.total, 1); assert(!JSON.stringify(result.body).includes('SYNTHETIC-MISSING-PARENT')); }
  assert.deepEqual(f.counts(), before); assert.equal(f.changes(), changeCount);
});
