import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
const formal = new URL('../src/server/index.mjs', import.meta.url);
const { createApp } = await import(existsSync(formal) ? formal : new URL('../../../../src/server/index.mjs', import.meta.url));
const entity = 'contract-deadline-reminders', password = 'synthetic-contract-deadline-password';
const route = (item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, url, payload, headers = {}, raw = false) => {
    const response = await fetch(base + url, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, text, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成期限管理員', email: 'deadline-admin@example.test', password, organizationName: '合成期限機構甲' }); assert.equal(setup.status, 201);
  const admin = { org: setup.body.organizations[0].id, cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken };
  const create = async (name, fields, client = admin, headers = {}) => { const result = await request(client, 'POST', '/api/' + name, fields, headers); assert.equal(result.status, 201, result.text); return result.body.item; };
  const patch = async (name, item, fields, client = admin) => { const result = await request(client, 'PATCH', '/api/' + name + '/' + item.id, { version: item.version, ...fields }); assert.equal(result.status, 200, result.text); return result.body.item; };
  const parentCase = await create('cases', { caseNo: 'DEADLINE-C01', name: '合成期限個案' }), employee = await create('employees', { employeeNo: 'DEADLINE-E01', name: '合成期限受指派員工' });
  const secondEmployee = await create('employees', { employeeNo: 'DEADLINE-E02', name: '合成期限員工二' });
  const clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = 'deadline-' + role + '@example.test'; await create('users', { email, name: '合成期限' + role, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { org: admin.org, cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken };
  }
  let counter = 0;
  const contractDraft = async (client = admin, caseId = parentCase.id) => create('case-contracts', { caseId, number: 'DEADLINE-CONTRACT-' + ++counter, title: '合成人工契約', startDate: '2026-10-01', endDate: '2026-12-31' }, client);
  const activate = (item, client = admin) => patch('case-contracts', item, { status: 'active', signedDate: '2026-09-20', statusDate: '2026-09-21', documentReference: '合成文件識別', sourceReference: '合成人工核對' }, client);
  const contract = await activate(await contractDraft());
  const draft = fields => ({ contractId: contract.id, contractVersion: contract.version, title: '合成期限提醒', content: '  合成期限內容\r\n末行  ', assigneeEmployeeId: employee.id, dueDate: '2026-12-10', note: '  合成備註\r\n尾行  ', ...fields });
  const reminder = (fields, client, headers) => create(entity, draft(fields), client, headers);
  const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => { const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [row.name, statement.all()]; })) });
  return { app, base, request, admin, clients, parentCase, employee, secondEmployee, contract, draft, reminder, create, patch, contractDraft, activate, raw };
}
test('real HTTP creates frozen source, edits raw long text, starts and completes without changing contract/tasks/announcements', async t => {
  const f = await fixture(t), before = f.raw().tables;
  let item = await f.reminder(undefined, f.clients.supervisor); assert.equal(item.contractVersion, f.contract.version); assert.equal(item.contractSnapshot.endDate, '2026-12-31');
  item = await f.patch(entity, item, { title: '合成提醒更正' }); assert.equal(item.content, f.draft().content); assert.equal(item.note, f.draft().note);
  item = await f.patch(entity, item, { status: 'in_progress', statusDate: '2026-12-01' });
  item = await f.patch(entity, item, { status: 'completed', statusDate: '2026-12-02', result: '  本次完成\r\n已人工核對  ' }); assert.equal(item.version, 4);
  const after = f.raw().tables; assert.deepEqual(after.records.filter(row => row.entity !== entity), before.records); assert.deepEqual(after.record_versions.filter(row => row.entity !== entity), before.record_versions);
  const frozen = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, note: '不能更改' })).status, 409); assert.deepEqual(f.raw(), frozen);
  const history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous')); assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [4, 3, 2, 1]); assert.equal(history.body.items[0].snapshot.result, item.result); assert.deepEqual(f.raw(), frozen);
});
test('roles reject before malformed parsing, same-org references and CSRF/auth guard leave all tables unchanged', async t => {
  const f = await fixture(t), item = await f.reminder(), frozen = f.raw();
  for (const role of ['finance', 'caregiver']) for (const [method, suffix, body] of [['GET', '', undefined], ['GET', '/' + item.id, undefined], ['GET', '/' + item.id + '/history', undefined], ['POST', '', '{'], ['PATCH', '/' + item.id, '{'], ['DELETE', '/' + item.id, undefined]]) {
    assert.equal((await f.request(f.clients[role], method, '/api/' + entity + suffix, body, {}, body === '{')).status, 403); assert.deepEqual(f.raw(), frozen);
  }
  assert.equal((await f.request(null, 'GET', route(item))).status, 401); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, title: 'CSRF forbidden' }, { 'X-CSRF-Token': 'wrong' })).status, 403); assert.deepEqual(f.raw(), frozen);
  const foreignOrg = await f.create('organizations', { name: '合成期限機構乙' }), foreign = { ...f.admin, org: foreignOrg.id };
  const otherCase = await f.create('cases', { caseNo: 'FOREIGN-C01', name: '合成外機構' }, foreign), otherEmployee = await f.create('employees', { employeeNo: 'FOREIGN-E01', name: '合成外員工' }, foreign);
  const otherContract = await f.activate(await f.contractDraft(foreign, otherCase.id), foreign), baseline = f.raw();
  for (const fields of [{ contractId: otherContract.id, contractVersion: otherContract.version }, { assigneeEmployeeId: otherEmployee.id }]) { assert.equal((await f.request(f.admin, 'POST', route(), f.draft(fields))).status, 422); assert.deepEqual(f.raw(), baseline); }
  assert.equal((await f.request(foreign, 'GET', route(item))).status, 404); assert.equal((await f.request(foreign, 'GET', route(item, '/history'))).status, 404); assert.deepEqual(f.raw(), baseline);
});
test('POST idem is exact, concurrent different keys cannot create two open reminders, cancellation permits manual new record', async t => {
  const f = await fixture(t), key = randomUUID(), payload = f.draft(), first = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(first.status, 201);
  const frozen = f.raw(), replay = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(replay.status, 201); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.raw(), frozen);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, title: 'different' }, { 'Idempotency-Key': key })).status, 409); assert.deepEqual(f.raw(), frozen);
  let cancelled = await f.patch(entity, first.body.item, { status: 'cancelled', statusDate: '2026-10-10', statusReason: '  本次取消\r\n依據  ' });
  const results = await Promise.all([f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': randomUUID() }), f.request(f.admin, 'POST', route(), { ...payload, title: 'parallel' }, { 'Idempotency-Key': randomUUID() })]); assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(cancelled.statusReason, '  本次取消\r\n依據  '); assert.notEqual(results.find(result => result.status === 201).body.item.id, cancelled.id);
});
test('source active/version required and frozen identity cannot change; terminal parent remains readable and actionable', async t => {
  const f = await fixture(t), draftContract = await f.contractDraft(), before = f.raw();
  assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ contractId: draftContract.id, contractVersion: 1 }))).status, 422);
  assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ contractVersion: f.contract.version - 1 }))).status, 409); assert.deepEqual(f.raw(), before);
  let item = await f.reminder(); const source = structuredClone(item.contractSnapshot), frozen = f.raw();
  for (const fields of [{ contractId: draftContract.id }, { contractVersion: 1 }, { contractSnapshot: { ...source } }]) { const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...fields }); assert.ok([409, 422].includes(result.status), result.text); assert.deepEqual(f.raw(), frozen); }
  const ended = await f.patch('case-contracts', f.contract, { status: 'expired', statusDate: '2027-01-01', statusReason: '合成人工處理到期' }); const baseline = f.raw();
  assert.equal((await f.request(f.admin, 'GET', route(item))).status, 200); assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).status, 200); assert.deepEqual(f.raw(), baseline);
  item = await f.patch(entity, item, { status: 'in_progress', statusDate: '2027-01-02' }); assert.deepEqual(item.contractSnapshot, source); assert.equal(item.contractVersion, ended.version - 1);
});
test('strict explicit date worklist/single/history query, business search and date classification are zero-write', async t => {
  const f = await fixture(t), item = await f.reminder(), frozen = f.raw();
  for (const suffix of ['', '?asOf=2026-12-10%0A', '?asOf=2026-12-10&page=1%0A', '?asOf=2026-12-10&unknown=x', '?asOf=2026-12-10&asOf=2026-12-11', '?asOf=2026-12-10&dueFrom=2026-12-01', '?asOf=2026-12-10&dueFrom=2026-01-01&dueTo=2027-01-02', '?asOf=2026-12-10&status=expired']) assert.equal((await f.request(f.admin, 'GET', route(null, suffix))).status, 422, suffix);
  for (const workState of ['before_due', 'on_due', 'past_due']) { const asOf = { before_due: '2026-12-09', on_due: '2026-12-10', past_due: '2026-12-11' }[workState], result = await f.request(f.admin, 'GET', route(null, '?asOf=' + asOf + '&workState=' + workState)); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, item.id); assert.equal(result.body.pageSize, 25); }
  assert.equal((await f.request(f.admin, 'GET', route(null, '?asOf=2026-12-10&q=' + f.employee.id))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', route(null, '?asOf=2026-12-10&contractId=' + randomUUID()))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route(item, '?asOf=2026-12-10'))).status, 422); assert.equal((await f.request(f.admin, 'GET', route(item, '/history?asOf=2026-12-10'))).status, 422); assert.deepEqual(f.raw(), frozen);
});
test('transition date/result/current cancellation reason required, cannot skip stage or change content during closure', async t => {
  const f = await fixture(t); let item = await f.reminder(), frozen = f.raw();
  for (const fields of [{ status: 'completed', statusDate: '2026-12-01', result: '不能跳過' }, { status: 'cancelled', statusDate: '2026-12-01' }, { status: 'in_progress' }]) { assert.ok([409, 422].includes((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...fields })).status)); assert.deepEqual(f.raw(), frozen); }
  item = await f.patch(entity, item, { status: 'in_progress', statusDate: '2026-12-01' }); frozen = f.raw();
  for (const fields of [{ status: 'completed', statusDate: '2026-11-30', result: '早於開始' }, { status: 'completed', statusDate: '2026-12-02', result: '結果', title: '偷偷改內容' }, { status: 'cancelled', statusDate: '2026-12-02', statusReason: '原因', assigneeEmployeeId: f.secondEmployee.id }]) { assert.ok([409, 422].includes((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...fields })).status)); assert.deepEqual(f.raw(), frozen); }
});
test('malformed JSON/current unknown snapshot/unsafe SQL and foreign parent disappear from current/list/history/PATCH', async t => {
  const f = await fixture(t), item = await f.reminder(), stored = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data;
  for (const data of ['{', 'null', '[]', JSON.stringify({ ...JSON.parse(stored), contractSnapshot: { ...item.contractSnapshot, unknown: { private: 'must not leak' } } })]) {
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(data, item.id); const frozen = f.raw();
    assert.equal((await f.request(f.admin, 'GET', route(null, '?asOf=2026-12-10'))).body.total, 0);
    for (const suffix of ['', '/history']) assert.equal((await f.request(f.admin, 'GET', route(item, suffix))).status, 404);
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, title: 'cannot change' })).status, 404); assert.deepEqual(f.raw(), frozen);
    assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ title: 'cannot bypass broken open reminder' }))).status, 409, 'corrupt existing raw row must not disappear from duplicate guard'); assert.deepEqual(f.raw(), frozen);
  }
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(stored, item.id);
  for (const version of [0n, 9007199254740992n]) { f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, item.id); const frozen = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(item))).status, 404); assert.equal((await f.request(f.admin, 'GET', route(null, '?asOf=2026-12-10'))).body.total, 0); assert.equal((await f.request(f.admin, 'POST', route(), f.draft())).status, 409); assert.deepEqual(f.raw(), frozen); }
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(1, item.id);
  const parentData = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(f.contract.id).data;
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(parentData), caseId: randomUUID() }), f.contract.id); const frozen = f.raw();
  assert.equal((await f.request(f.admin, 'GET', route(item))).status, 404); assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).status, 404); assert.deepEqual(f.raw(), frozen);
});
test('bad historical snapshot/null/invalid JSON/SQL mismatch are omitted without expanding or rewriting stored bytes', async t => {
  const f = await fixture(t); let item = await f.reminder(); const first = structuredClone(item); item = await f.patch(entity, item, { title: '第二版' });
  const historical = f.app.db.prepare('SELECT rowid AS fixtureRowId,snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id);
  for (const snapshot of ['{', 'null', '[]', JSON.stringify({ ...first, contractSnapshot: { ...first.contractSnapshot, unknown: 'private' } }), JSON.stringify({ ...first, version: 2 })]) {
    // Synthetic corruption fixture only: restore the exact original trigger SQL before exercising GET.
    const triggers = f.app.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='record_versions'").all();
    for (const trigger of triggers) f.app.db.prepare('DROP TRIGGER "' + trigger.name.replace(/"/g, '""') + '"').run();
    try { f.app.db.prepare('UPDATE record_versions SET snapshot=? WHERE rowid=?').run(snapshot, historical.fixtureRowId); }
    finally { for (const trigger of triggers) f.app.db.exec(trigger.sql); }
    const frozen = f.raw(), result = await f.request(f.admin, 'GET', route(item, '/history?compare=previous')); assert.equal(result.status, 200); assert.deepEqual(result.body.items.map(row => row.version), [2]); assert.deepEqual(f.raw(), frozen);
  }
});
test('actual CAS concurrency commits one revision; inactive retained assignment readable, fresh assignment rejected', async t => {
  const f = await fixture(t), item = await f.reminder();
  const results = await Promise.all([f.request(f.admin, 'PATCH', route(item), { version: item.version, title: '更新一' }), f.request(f.clients.supervisor, 'PATCH', route(item), { version: item.version, title: '更新二' })]); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = results.find(result => result.status === 200).body.item; assert.equal(saved.version, 2); assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM record_versions WHERE record_id=?').get(item.id).n, 2);
  await f.patch('employees', f.employee, { status: 'inactive' }); const baseline = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(saved))).status, 200); assert.deepEqual(f.raw(), baseline);
  const another = await f.activate(await f.contractDraft()); assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ contractId: another.id, contractVersion: another.version }))).status, 422);
  const edited = await f.patch(entity, saved, { note: '人工仍可補充備註' }); assert.equal(edited.assigneeEmployeeId, f.employee.id);
});
