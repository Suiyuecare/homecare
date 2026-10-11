import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';

const password = 'synthetic-contract-task-password', contracts = 'case-contracts', tasks = 'internal-tasks';
const path = (entity, item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, url, payload, headers = {}, raw = false) => {
    const response = await fetch(base + url, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, text, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成契約管理員', email: 'contract-admin@example.test', password, organizationName: '合成契約機構甲' }); assert.equal(setup.status, 201);
  const admin = { org: setup.body.organizations[0].id, cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken };
  const create = async (entity, data, client = admin, headers = {}) => { const result = await request(client, 'POST', path(entity), data, headers); assert.equal(result.status, 201, result.text); return result.body.item; };
  const patch = async (entity, item, data, client = admin) => { const result = await request(client, 'PATCH', path(entity, item), { version: item.version, ...data }); assert.equal(result.status, 200, result.text); return result.body.item; };
  const caseItem = await create('cases', { name: '合成契約個案', caseNo: 'CONTRACT-C01' }), secondCase = await create('cases', { name: '合成第二個案', caseNo: 'CONTRACT-C02' });
  const employee = await create('employees', { name: '合成受指派員工', employeeNo: 'TASK-E01' }), secondEmployee = await create('employees', { name: '合成第二員工', employeeNo: 'TASK-E02' });
  const clients = { admin };
  for (const [key, role, linked] of [['supervisor', 'supervisor', false], ['finance', 'finance', true], ['unlinkedFinance', 'finance', false], ['caregiver', 'caregiver', true]]) {
    const email = `contract-${key}@example.test`; await create('users', { name: '合成' + key, email, password, role, ...(linked ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[key] = { org: admin.org, cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken };
  }
  let number = 0;
  const draft = (overrides = {}) => ({ caseId: caseItem.id, number: `LOCAL-CONTRACT-${++number}`, title: '合成個案契約', startDate: '2026-10-01', endDate: '2026-12-31', ...overrides });
  const createContract = (overrides, client) => create(contracts, draft(overrides), client);
  const activate = item => patch(contracts, item, { status: 'active', statusDate: '2026-09-21', signedDate: '2026-09-20', documentReference: '合成文件識別', sourceReference: '合成人工核對來源' });
  const work = (overrides = {}) => ({ title: '合成內部待辦', content: '合成整理文件', assigneeEmployeeId: employee.id, dueDate: '2026-10-20', ...overrides });
  const createTask = (overrides, client) => create(tasks, work(overrides), client);
  const raw = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => { const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [row.name, statement.all()]; }));
  const foreign = async () => { const organization = await create('organizations', { name: '合成契約機構乙' }), client = { ...admin, org: organization.id };
    const caseItem = await create('cases', { name: 'SYNTHETIC-FOREIGN', caseNo: 'FOREIGN-C' }, client), employee = await create('employees', { name: 'SYNTHETIC-FOREIGN', employeeNo: 'FOREIGN-E' }, client);
    return { client, caseItem, employee }; };
  return { app, base, request, create, patch, admin, clients, caseItem, secondCase, employee, secondEmployee, draft, createContract, activate, work, createTask, raw, foreign };
}

test('contract full lifecycle edits draft, locks active, manually expires, renews with new identity and preserves old versions', async t => {
  const f = await fixture(t); let item = await f.createContract({ note: '  備註\r\n末行  ' }, f.clients.supervisor);
  item = await f.patch(contracts, item, { title: '合成核對後契約' }); item = await f.activate(item); assert.equal(item.version, 3);
  const active = structuredClone(item), before = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', path(contracts, item), { version: item.version, title: '不應更改' })).status, 409); assert.deepEqual(f.raw(), before);
  assert.equal((await f.request(f.admin, 'PATCH', path(contracts, item), { version: item.version, status: 'expired', statusDate: '2026-12-31', statusReason: '合成到期' })).status, 422); assert.deepEqual(f.raw(), before);
  item = await f.patch(contracts, item, { status: 'expired', statusDate: '2027-01-01', statusReason: '  合成人工到期\r\n依據  ' });
  const previous = structuredClone(item), renewed = await f.createContract({ renewedFromId: item.id, startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.notEqual(renewed.id, item.id); assert.equal(renewed.renewedFromId, item.id); assert.equal(renewed.version, 1);
  const current = await f.request(f.admin, 'GET', path(contracts, item)); assert.deepEqual(current.body.item, previous);
  const frozen = f.raw(), history = await f.request(f.admin, 'GET', path(contracts, item, '/history?compare=previous'));
  assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [4, 3, 2, 1]); assert.deepEqual(history.body.items[1].snapshot, active);
  assert.equal(item.note, '  備註\r\n末行  '); assert.deepEqual(f.raw(), frozen);
  assert.equal((await f.request(f.admin, 'PATCH', path(contracts, item), { version: item.version, note: 'edit' })).status, 409); assert.deepEqual(f.raw(), frozen);
});
test('renewal requires same case, later period and one non-cancelled successor even concurrent requests', async t => {
  const f = await fixture(t), old = await f.activate(await f.createContract()), foreign = await f.foreign();
  for (const overrides of [{ renewedFromId: old.id, caseId: f.secondCase.id, startDate: '2027-01-01' }, { renewedFromId: old.id, startDate: '2026-12-31' }, { renewedFromId: foreign.caseItem.id, startDate: '2027-01-01' }]) {
    const before = f.raw(), result = await f.request(f.admin, 'POST', path(contracts), f.draft({ endDate: '2027-12-31', ...overrides })); assert.ok([409, 422].includes(result.status), result.text); assert.deepEqual(f.raw(), before);
  }
  const payload = f.draft({ renewedFromId: old.id, startDate: '2027-01-01', endDate: '2027-12-31' });
  const results = await Promise.all([f.request(f.admin, 'POST', path(contracts), payload, { 'Idempotency-Key': randomUUID() }), f.request(f.admin, 'POST', path(contracts), { ...payload, number: 'SECOND-RENEWAL' }, { 'Idempotency-Key': randomUUID() })]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  let renewed = results.find(result => result.status === 201).body.item;
  renewed = await f.patch(contracts, renewed, { status: 'cancelled', statusDate: '2026-10-10', statusReason: '合成取消重建' });
  assert.equal((await f.createContract({ renewedFromId: old.id, startDate: '2027-01-01', endDate: '2027-12-31' })).status, 'draft');
  assert.equal((await f.request(f.admin, 'GET', path(contracts, old))).body.item.version, old.version);
});
test('strict contract role isolation and non-manager task writes reject before malformed JSON parse', async t => {
  const f = await fixture(t), contract = await f.createContract(), task = await f.createTask();
  for (const role of ['finance', 'caregiver']) {
    for (const [method, url, body, raw] of [['GET', path(contracts)], ['GET', path(contracts, contract)], ['GET', path(contracts, contract, '/history')], ['POST', path(contracts), '{', true], ['PATCH', path(contracts, contract), '{', true], ['DELETE', path(contracts, contract)], ['POST', path(tasks), '{', true], ['PATCH', path(tasks, task), '{', true]]) {
      const before = f.raw(), result = await f.request(f.clients[role], method, url, body, {}, raw); assert.equal(result.status, 403, role + ' ' + url + result.text); assert.deepEqual(f.raw(), before);
    }
  }
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) assert.equal((await f.request(f.clients[role], 'GET', path(tasks, task))).status, 200);
  const unlinked = await f.request(f.clients.unlinkedFinance, 'GET', path(tasks)); assert.equal(unlinked.status, 200); assert.equal(unlinked.body.total, 0);
  assert.equal((await f.request(f.clients.unlinkedFinance, 'GET', path(tasks, null, '?assigneeEmployeeId=' + f.employee.id))).status, 404);
});
test('tasks start, edit progress, complete with fresh result and lock terminal; pending cannot skip to completed', async t => {
  const f = await fixture(t); let item = await f.createTask({ content: '  原內容\r\n末行  ', note: '  原備註  ' });
  let before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', path(tasks, item), { version: item.version, status: 'completed', statusDate: '2026-10-10', result: '合成完成' })).status, 409); assert.deepEqual(f.raw(), before);
  item = await f.patch(tasks, item, { status: 'in_progress', statusDate: '2026-10-10' });
  item = await f.patch(tasks, item, { title: '合成已開始處理' }, f.clients.supervisor); assert.equal(item.content, '  原內容\r\n末行  ');
  before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', path(tasks, item), { version: item.version, status: 'completed', statusDate: '2026-10-11' })).status, 422); assert.deepEqual(f.raw(), before);
  assert.equal((await f.request(f.admin, 'PATCH', path(tasks, item), { version: item.version, status: 'completed', statusDate: '2026-10-09', result: '合成結果' })).status, 422); assert.deepEqual(f.raw(), before);
  item = await f.patch(tasks, item, { status: 'completed', statusDate: '2026-10-11', result: '  合成完成\r\n末行  ' }); assert.equal(item.result, '  合成完成\r\n末行  ');
  const frozen = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', path(tasks, item), { version: item.version, note: 'cannot edit' })).status, 409); assert.deepEqual(f.raw(), frozen);
  const history = await f.request(f.clients.caregiver, 'GET', path(tasks, item, '/history?compare=previous')); assert.equal(history.status, 200); assert.equal(history.body.total, 4); assert.deepEqual(f.raw(), frozen);
});
test('task reassignment current/history are own-only, old different assignee versions hidden and exact previous gap never skipped', async t => {
  const f = await fixture(t); let item = await f.createTask(); item = await f.patch(tasks, item, { status: 'in_progress', statusDate: '2026-10-10' });
  item = await f.patch(tasks, item, { assigneeEmployeeId: f.secondEmployee.id });
  for (const role of ['caregiver', 'finance']) for (const url of [path(tasks, item), path(tasks, item, '/history'), path(tasks, null, '?assigneeEmployeeId=' + f.secondEmployee.id)]) {
    const before = f.raw(); assert.equal((await f.request(f.clients[role], 'GET', url)).status, 404); assert.deepEqual(f.raw(), before);
  }
  item = await f.patch(tasks, item, { assigneeEmployeeId: f.employee.id });
  const before = f.raw(), history = await f.request(f.clients.caregiver, 'GET', path(tasks, item, '/history?compare=previous'));
  assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [4, 2, 1]); assert.equal(history.body.items[0].comparison.status, 'unavailable'); assert.deepEqual(f.raw(), before);
});
test('this-operation cancellation reason required, cancellation releases no workflow side effects and identities remain fixed', async t => {
  const f = await fixture(t), contract = await f.createContract({ note: 'old reason cannot infer' }), task = await f.createTask();
  for (const [entity, item] of [[contracts, contract], [tasks, task]]) {
    const before = f.raw();
    for (const update of [{ status: 'cancelled', statusDate: '2026-10-10' }, { status: 'cancelled', statusDate: '2026-10-10', statusReason: ' ' }, { status: 'cancelled', statusDate: '2026-10-10', statusReason: '合成取消', title: 'also edit' }]) {
      const result = await f.request(f.admin, 'PATCH', path(entity, item), { version: item.version, ...update }); assert.ok([409, 422].includes(result.status), result.text); assert.deepEqual(f.raw(), before);
    }
    const cancelled = await f.patch(entity, item, { status: 'cancelled', statusDate: '2026-10-10', statusReason: '  合成取消\r\n依據  ' });
    const after = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', path(entity, cancelled), { version: cancelled.version, note: 'new' })).status, 409); assert.deepEqual(f.raw(), after);
  }
  const original = await f.createContract();
  for (const update of [{ caseId: f.secondCase.id }, { number: 'NEW-IDENTITY' }, { renewedFromId: randomUUID() }]) {
    const before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', path(contracts, original), { version: original.version, ...update })).status, 409); assert.deepEqual(f.raw(), before);
  }
});
test('contract/task POST idempotency, CAS, CSRF and missing version preserve all tables on failure', async t => {
  const f = await fixture(t);
  for (const [entity, payload] of [[contracts, f.draft()], [tasks, f.work()]]) {
    const key = randomUUID(), created = await f.request(f.admin, 'POST', path(entity), payload, { 'Idempotency-Key': key }); assert.equal(created.status, 201, created.text);
    const before = f.raw(), retry = await f.request(f.admin, 'POST', path(entity), payload, { 'Idempotency-Key': key }); assert.deepEqual(retry.body, created.body); assert.deepEqual(f.raw(), before);
    assert.equal((await f.request(f.admin, 'POST', path(entity), { ...payload, note: 'different' }, { 'Idempotency-Key': key })).status, 409); assert.deepEqual(f.raw(), before);
    const item = created.body.item;
    for (const [body, headers, status] of [[{ version: 2, note: 'x' }, {}, 409], [{ note: 'x' }, {}, 422], [{ version: 1, note: 'x' }, { 'X-CSRF-Token': 'invalid' }, 403]]) {
      assert.equal((await f.request(f.admin, 'PATCH', path(entity, item), body, headers)).status, status); assert.deepEqual(f.raw(), before);
    }
    assert.equal((await f.request(f.admin, 'DELETE', path(entity, item))).status, 404); assert.deepEqual(f.raw(), before);
  }
});
test('same-org references required and invalid dates/unknown fields/new terminal states fail atomically', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  for (const payload of [f.draft({ caseId: foreign.caseItem.id }), f.draft({ endDate: '2026-09-30' }), f.draft({ startDate: '0000-01-01' }), f.draft({ signedDate: '2026-02-30' }), f.draft({ status: 'active' }), f.draft({ secret: {} })]) {
    const before = f.raw(), result = await f.request(f.admin, 'POST', path(contracts), payload); assert.equal(result.status, 422, result.text); assert.deepEqual(f.raw(), before);
  }
  for (const payload of [f.work({ assigneeEmployeeId: foreign.employee.id }), f.work({ dueDate: '2026-02-30' }), f.work({ priority: 'urgent' }), f.work({ status: 'completed' }), f.work({ content: [] })]) {
    const before = f.raw(), result = await f.request(f.admin, 'POST', path(tasks), payload); assert.equal(result.status, 422, result.text); assert.deepEqual(f.raw(), before);
  }
});
test('explicit expiry and due-date queries are inclusive readonly, bounded strict and never automatically change state', async t => {
  const f = await fixture(t), item = await f.activate(await f.createContract()), task = await f.createTask(), foreign = await f.foreign(), frozen = f.raw();
  for (const [asOf, expiry] of [['2026-09-30', 'not_started'], ['2026-10-01', 'within_term'], ['2026-12-31', 'within_term'], ['2027-01-01', 'past_end']]) {
    const result = await f.request(f.admin, 'GET', path(contracts, null, `?asOf=${asOf}&expiry=${expiry}`)); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].status, 'active'); assert.deepEqual(f.raw(), frozen);
  }
  assert.equal((await f.request(f.admin, 'GET', path(tasks, null, '?dueFrom=2026-10-20&dueTo=2026-10-20'))).body.total, 1);
  for (const [entity, suffix] of [[contracts, '?page=1%0A'], [contracts, '?asOf=2026-10-10%0A'], [contracts, '?expiry=past_end'], [contracts, '?expiryFrom=2026-10-10'], [contracts, '?expiryFrom=2026-01-01&expiryTo=2027-01-02'], [contracts, '?status=active&status=active'], [tasks, '?dueFrom=2026-10-20'], [tasks, '?q=' + 'x'.repeat(201)], [tasks, '?employeeId=' + f.employee.id]]) {
    assert.equal((await f.request(f.admin, 'GET', path(entity, null, suffix))).status, 422, suffix); assert.deepEqual(f.raw(), frozen);
  }
  for (const [entity, record, suffix] of [[contracts, item, '?q=x'], [tasks, task, '?q=x'], [contracts, item, '/history?asOf=2026-10-10']]) assert.equal((await f.request(f.admin, 'GET', path(entity, record, suffix))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', path(contracts, null, '?caseId=' + foreign.caseItem.id))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', path(tasks, null, '?assigneeEmployeeId=' + foreign.employee.id))).status, 404); assert.deepEqual(f.raw(), frozen);
});
test('closed current record data and missing/foreign parents are invisible in list/current/history/PATCH with zero writes', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  for (const [entity, item, parentKey, foreignParent] of [[contracts, await f.createContract(), 'caseId', foreign.caseItem.id], [tasks, await f.createTask(), 'assigneeEmployeeId', foreign.employee.id]]) {
    const original = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data;
    for (const data of ['null', '[]', '{invalid', JSON.stringify({ ...JSON.parse(original), unknown: { secret: 'SYNTHETIC-NESTED-SECRET' } }), JSON.stringify({ ...JSON.parse(original), [parentKey]: foreignParent }), JSON.stringify({ ...JSON.parse(original), [parentKey]: randomUUID() })]) {
      f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(data, item.id); const before = f.raw();
      for (const [method, url, body] of [['GET', path(entity, item)], ['GET', path(entity, item, '/history')], ['PATCH', path(entity, item), { version: item.version, note: 'cannot repair invisible' }]]) {
        const result = await f.request(f.admin, method, url, body); assert.equal(result.status, 404, result.text); assert.ok(!result.text.includes('SYNTHETIC-NESTED-SECRET')); assert.deepEqual(f.raw(), before);
      }
      const result = await f.request(f.admin, 'GET', path(entity)); assert.equal(result.status, 200); assert.equal(result.body.total, 0); assert.deepEqual(f.raw(), before);
    }
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(original, item.id);
  }
});
test('history filters invalid JSON/null, foreign parents, unknown snapshot fields, changed immutable identity and mismatched SQL version', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  for (const [entity, item] of [[contracts, await f.createContract()], [tasks, await f.createTask()]]) {
    const bad = ['null', '[]', '{invalid', JSON.stringify({ ...item, version: 999 }), JSON.stringify({ ...item, version: 5, unknown: 'SYNTHETIC-NESTED-SECRET' }),
      JSON.stringify({ ...item, version: 6, id: randomUUID() }), JSON.stringify({ ...item, version: 7, orgId: foreign.client.org }),
      JSON.stringify({ ...item, version: 8, ...(entity === contracts ? { number: 'wrong-immutable' } : { assigneeEmployeeId: foreign.employee.id }) })];
    bad.forEach((snapshot, index) => f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, index + 2, snapshot, item.updatedAt, 'synthetic-import'));
    const before = f.raw(), result = await f.request(f.admin, 'GET', path(entity, item, '/history?compare=previous'));
    assert.equal(result.status, 200, result.text); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].version, 1); assert.ok(!result.text.includes('SYNTHETIC-NESTED-SECRET')); assert.deepEqual(f.raw(), before);
  }
});
test('unsafe or nonpositive SQL versions and broken parent JSON remain invisible instead of causing 500 or exposing data', async t => {
  const f = await fixture(t);
  for (const [entity, item, parent] of [[contracts, await f.createContract(), f.caseItem], [tasks, await f.createTask(), f.employee]]) {
    for (const version of [0n, -1n, 9007199254740992n, 9223372036854775807n]) {
      f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, item.id);
      const before = f.raw();
      for (const url of [path(entity, item), path(entity, item, '/history')]) assert.equal((await f.request(f.admin, 'GET', url)).status, 404);
      const list = await f.request(f.admin, 'GET', path(entity)); assert.equal(list.status, 200); assert.equal(list.body.total, 0); assert.deepEqual(f.raw(), before);
    }
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(item.version, item.id);
    const data = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(parent.id).data;
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run('{invalid', parent.id);
    const before = f.raw();
    for (const url of [path(entity, item), path(entity, item, '/history')]) assert.equal((await f.request(f.admin, 'GET', url)).status, 404);
    const key = entity === contracts ? 'caseId' : 'assigneeEmployeeId';
    assert.equal((await f.request(f.admin, 'GET', path(entity, null, `?${key}=${parent.id}`))).status, 404); assert.deepEqual(f.raw(), before);
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(data, parent.id);
  }
});
