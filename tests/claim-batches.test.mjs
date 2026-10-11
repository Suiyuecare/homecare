import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { claimCsvCell, claimBatchSummary } from '../src/server/claim-batches.mjs';

const entity = 'claim-batches', password = 'synthetic-offline-claim-password';
const route = (item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, data, headers = {}, raw = false) => {
    const response = await fetch(base + path, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data !== undefined ? { body: raw ? data : JSON.stringify(data) } : {}) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, text, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成離線核銷管理員', email: 'claim-admin@example.test', password, organizationName: '合成離線機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id };
  const create = async (kind, data, client = admin, headers = {}) => { const result = await request(client, 'POST', `/api/${kind}`, data, headers); assert.equal(result.status, 201, result.text); return result.body.item; };
  const patch = async (kind, item, data, client = admin) => { const result = await request(client, 'PATCH', `/api/${kind}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, result.text); return result.body.item; };
  const caseItem = await create('cases', { name: '合成核銷個案', caseNo: 'CLAIM-C01' });
  const employee = await create('employees', { name: '合成核銷員工', employeeNo: 'CLAIM-E01' });
  const clients = { admin };
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = `claim-${role}@example.test`;
    await create('users', { name: '合成核銷' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org };
  }
  let billCount = 0, batchCount = 0;
  const bill = async ({ amount = 24003, month = '2026-10', client = admin, parentCase = caseItem, issued = true, number } = {}) => {
    const item = await create('billing-documents', { caseId: parentCase.id, month, number: number || `CLAIM-BILL-${++billCount}`,
      lineItems: [{ label: '合成人工核銷來源', quantity: 1, unitPriceCents: amount }] }, client);
    return issued ? patch('billing-documents', item, { status: 'issued', sourceReference: '合成帳單核定依據' }, client) : item;
  };
  const invoice = await bill();
  const batch = (overrides = {}) => ({ month: '2026-10', number: `LOCAL-CLAIM-${++batchCount}`, billingDocumentIds: [invoice.id], sourceReference: '合成人工批次依據', ...overrides });
  const createBatch = (overrides, client) => create(entity, batch(overrides), client);
  const verify = item => patch(entity, item, { status: 'verified' });
  const reply = (invoiceId, overrides = {}) => ({ billingDocumentId: invoiceId, reference: '合成人工收到回應', status: 'accepted', amountCents: 24003, reason: '', ...overrides });
  const raw = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.name, app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()]));
  const foreign = async () => {
    const organization = await create('organizations', { name: '合成離線機構乙' }), client = { ...admin, org: organization.id };
    const parentCase = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'FOREIGN-CLAIM' }, client);
    return { client, parentCase, invoice: await bill({ client, parentCase }) };
  };
  return { app, base, request, create, patch, admin, clients, caseItem, invoice, bill, batch, createBatch, verify, reply, raw, foreign };
}

test('offline batch complete workflow freezes source and exactly separates accepted/rejected/unanswered amounts', async t => {
  const f = await fixture(t), second = await f.bill({ amount: 10001 });
  let item = await f.createBatch({ billingDocumentIds: [f.invoice.id, second.id], note: '  合成備註\r\n最後一行  ' }, f.clients.finance);
  assert.deepEqual(item.sourceSnapshots.map(row => [row.billingDocumentId, row.version, row.amountCents]), [[f.invoice.id, 2, 24003], [second.id, 2, 10001]]);
  assert.equal(item.summary.amountCents, 34004); assert.equal(item.summary.unansweredAmountCents, 34004);
  item = await f.verify(item);
  const frozen = structuredClone(item.sourceSnapshots);
  item = await f.patch(entity, item, { status: 'reconciling', responseSourceReference: '合成收到回覆文件', responses: [f.reply(f.invoice.id)] }, f.clients.finance);
  assert.equal(item.summary.acceptedAmountCents, 24003); assert.equal(item.summary.unansweredAmountCents, 10001);
  const before = f.raw(); const incomplete = await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'closed' });
  assert.equal(incomplete.status, 409); assert.deepEqual(f.raw(), before);
  item = await f.patch(entity, item, { responses: [...item.responses, f.reply(second.id, { status: 'rejected', amountCents: 0, reason: '合成來源需補正' })] });
  item = await f.patch(entity, item, { status: 'closed' });
  assert.deepEqual(item.sourceSnapshots, frozen); assert.equal(item.summary.rejectedAmountCents, 10001); assert.equal(item.summary.acceptedAmountCents, 24003);
  assert.equal(item.summary.unansweredAmountCents, 0); assert.equal(item.note, '  合成備註\r\n最後一行  ');
  const beforeReads = f.raw(), history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous'));
  assert.equal(history.status, 200); assert.equal(history.body.total, 5); assert.deepEqual(f.raw(), beforeReads);
  for (const target of ['reconciling', 'cancelled', 'draft']) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: target, note: '合成不應改寫' });
    assert.equal(result.status, 409); assert.deepEqual(f.raw(), beforeReads);
  }
});

test('only admin and finance can read/write/export/history; role guard runs before malformed JSON parse', async t => {
  const f = await fixture(t), item = await f.verify(await f.createBatch());
  for (const role of ['supervisor', 'caregiver']) for (const [method, path, payload, raw] of [
    ['GET', route()], ['GET', route(item)], ['GET', route(item, '/history')], ['GET', route(item, '/export?format=csv')],
    ['POST', route(), '{', true], ['PATCH', route(item), '{', true], ['DELETE', route(item)]
  ]) {
    const before = f.raw(), result = await f.request(f.clients[role], method, path, payload, {}, raw);
    assert.equal(result.status, 403, `${role} ${path}: ${result.text}`); assert.deepEqual(f.raw(), before);
  }
  for (const path of [route(), route(item), route(item, '/history'), route(item, '/export?format=json')]) assert.equal((await f.request(f.clients.finance, 'GET', path)).status, 200);
});

test('draft sources reject duplicates, foreign organization, wrong month, drafts, voided and derived/nested injection with zero writes', async t => {
  const f = await fixture(t), foreign = await f.foreign(), draft = await f.bill({ issued: false }), wrongMonth = await f.bill({ month: '2026-09' }), issued = await f.bill();
  const voided = await f.patch('billing-documents', issued, { status: 'voided', note: '合成作廢' });
  const attacks = [
    { billingDocumentIds: [] }, { billingDocumentIds: Array(101).fill(f.invoice.id) }, { billingDocumentIds: [f.invoice.id, f.invoice.id] }, { billingDocumentIds: [foreign.invoice.id] },
    { billingDocumentIds: [wrongMonth.id] }, { billingDocumentIds: [draft.id] }, { billingDocumentIds: [voided.id] }, { billingDocumentIds: [{ id: f.invoice.id }] },
    { sourceSnapshots: [] }, { summary: { amountCents: 0 } }, { status: 'verified' }, { responses: [f.reply(f.invoice.id)] }, { month: '0000-10' }, { number: 'line\nbreak' }
  ];
  for (const attack of attacks) { const before = f.raw(), result = await f.request(f.admin, 'POST', route(), f.batch(attack)); assert.ok([409, 422].includes(result.status), result.text); assert.deepEqual(f.raw(), before); }
});

test('same source cannot be reserved concurrently; cancellation requires this-operation reason and releases source without reuse of number', async t => {
  const f = await fixture(t), first = f.batch({ number: 'CONCURRENT-01' }), second = { ...first, number: 'CONCURRENT-02' };
  const results = await Promise.all([f.request(f.admin, 'POST', route(), first, { 'Idempotency-Key': randomUUID() }), f.request(f.admin, 'POST', route(), second, { 'Idempotency-Key': randomUUID() })]);
  assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
  let item = results.find(row => row.status === 201).body.item;
  const before = f.raw(); for (const values of [{ status: 'cancelled' }, { status: 'cancelled', note: ' ' }, { status: 'cancelled', note: '合成原因', sourceReference: 'changed' }]) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...values }); assert.ok([409, 422].includes(result.status)); assert.deepEqual(f.raw(), before);
  }
  item = await f.patch(entity, item, { status: 'cancelled', note: '合成退回重建原因' });
  const fresh = await f.createBatch(); assert.equal(fresh.status, 'draft');
  const beforeDuplicate = f.raw(), duplicate = await f.request(f.admin, 'POST', route(), f.batch({ number: item.number, billingDocumentIds: [(await f.bill()).id] }));
  assert.equal(duplicate.status, 409);
  const afterBill = f.raw(); assert.equal(afterBill.records.filter(row => row.entity === entity).length, beforeDuplicate.records.filter(row => row.entity === entity).length);
  const terminalBefore = f.raw(), terminal = await f.request(f.admin, 'PATCH', route(item), { version: item.version, note: 'changed' }); assert.equal(terminal.status, 409); assert.deepEqual(f.raw(), terminalBefore);
});

test('POST idempotency retry returns same batch; changed body conflicts and CSRF/CAS failures make zero writes', async t => {
  const f = await fixture(t), key = randomUUID(), payload = f.batch();
  const created = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(created.status, 201);
  const before = f.raw(), retry = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(retry.status, 201); assert.deepEqual(retry.body, created.body); assert.deepEqual(f.raw(), before);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, note: '合成不同內容' }, { 'Idempotency-Key': key })).status, 409); assert.deepEqual(f.raw(), before);
  const item = created.body.item;
  for (const [version, headers, expected] of [[0, {}, 422], [2, {}, 409], [1, { 'X-CSRF-Token': 'invalid' }, 403]]) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version, note: '合成未保存' }, headers); assert.equal(result.status, expected); assert.deepEqual(f.raw(), before);
  }
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404); assert.deepEqual(f.raw(), before);
});

test('draft preserves exact CRLF text and identities; verified content locks and malformed responses cannot change totals', async t => {
  const f = await fixture(t); let item = await f.createBatch({ note: '  多行\r\n備註  ', sourceReference: '  人工\r\n依據  ' });
  item = await f.patch(entity, item, { billingDocumentIds: item.billingDocumentIds }); assert.equal(item.note, '  多行\r\n備註  '); assert.equal(item.sourceReference, '  人工\r\n依據  ');
  for (const update of [{ month: '2026-11' }, { number: 'changed' }]) { const before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...update })).status, 409); assert.deepEqual(f.raw(), before); }
  item = await f.verify(item);
  const beforeDirectClose = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'closed', responseSourceReference: '合成依據', responses: [f.reply(f.invoice.id)] })).status, 409);
  assert.deepEqual(f.raw(), beforeDirectClose);
  for (const update of [{ note: 'changed' }, { sourceReference: 'changed' }, { billingDocumentIds: [(await f.bill()).id] }, { status: 'draft' }]) {
    const before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...update })).status, 409); assert.deepEqual(f.raw(), before);
  }
  const invalidReplies = [f.reply(f.invoice.id, { amountCents: 24002 }), f.reply(f.invoice.id, { amountCents: 24003.1 }), f.reply(f.invoice.id, { amountCents: '24003' }),
    f.reply(f.invoice.id, { amountCents: 1e16 }), f.reply(f.invoice.id, { extra: 'SYNTHETIC-NESTED-SECRET' }), f.reply(f.invoice.id, { status: 'rejected', amountCents: 1, reason: '合成退件' }),
    f.reply(f.invoice.id, { status: 'rejected', amountCents: 0 }), f.reply(f.invoice.id, { status: 'pending', amountCents: 1 }), f.reply(f.invoice.id, { reference: '' }), f.reply(randomUUID())];
  for (const reply of invalidReplies) { const before = f.raw(), result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'reconciling', responseSourceReference: '合成共同依據', responses: [reply] }); assert.equal(result.status, 422, result.text); assert.deepEqual(f.raw(), before); }
  const before = f.raw(), duplicate = await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'reconciling', responseSourceReference: '合成共同依據', responses: [f.reply(f.invoice.id), f.reply(f.invoice.id)] });
  assert.equal(duplicate.status, 422); assert.deepEqual(f.raw(), before);
});

test('pending replies remain distinct and prevent close; after parent voided frozen reads/history/export and manual responses remain valid', async t => {
  const f = await fixture(t); let item = await f.verify(await f.createBatch()); const sources = structuredClone(item.sourceSnapshots);
  await f.patch('billing-documents', f.invoice, { status: 'voided', note: '合成父帳單作廢' });
  for (const path of [route(item), route(item, '/history'), route(item, '/export?format=json')]) { const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', path)).status, 200); assert.deepEqual(f.raw(), before); }
  item = await f.patch(entity, item, { status: 'reconciling', responseSourceReference: '合成收到文件', responses: [f.reply(f.invoice.id, { status: 'pending', amountCents: 0 })] });
  assert.equal(item.summary.pendingAmountCents, 24003); assert.equal(item.summary.unansweredAmountCents, 0);
  const before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'closed' })).status, 409); assert.deepEqual(f.raw(), before);
  item = await f.patch(entity, item, { responses: [f.reply(f.invoice.id, { status: 'rejected', amountCents: 0, reason: '合成人工退件' })] });
  item = await f.patch(entity, item, { status: 'closed' }); assert.deepEqual(item.sourceSnapshots, sources); assert.equal(item.summary.rejectedAmountCents, 24003);
});

test('draft revalidation rejects voided or changed original invoice version; cancelling keeps traceable snapshot', async t => {
  const f = await fixture(t); let item = await f.createBatch();
  const sql = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(f.invoice.id);
  f.app.db.prepare('UPDATE records SET version=version+1 WHERE id=?').run(f.invoice.id);
  let before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'verified' })).status, 409); assert.deepEqual(f.raw(), before);
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(sql.version, f.invoice.id);
  await f.patch('billing-documents', f.invoice, { status: 'voided', note: '合成取消來源' });
  before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'verified' })).status, 409); assert.deepEqual(f.raw(), before);
  item = await f.patch(entity, item, { status: 'cancelled', note: '合成來源變動需重建' }); assert.equal(item.sourceSnapshots[0].version, 2);
});

test('strict paging/search/query and single/export/history parameters reject unknown, duplicate or malformed values with zero writes', async t => {
  const f = await fixture(t), item = await f.verify(await f.createBatch());
  for (const suffix of ['?page=0', '?pageSize=101', '?page=1%0A', '?pageSize=25%0A', '?month=2026-10%0A', '?status=sent', '?month=0000-10', '?q=' + 'x'.repeat(201), '?page=1&page=1', '?caseId=' + f.caseItem.id, '?billingDocumentId=' + f.invoice.id]) {
    const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(null, suffix))).status, 422, suffix); assert.deepEqual(f.raw(), before);
  }
  for (const suffix of ['?q=x', '/history?status=draft', '/history?compare=all', '/history?compare=previous&compare=previous', '/export?format=xml', '/export?format=csv&format=json', '/export?format=csv&secret=x']) {
    const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(item, suffix))).status, 422, suffix); assert.deepEqual(f.raw(), before);
  }
  const result = await f.request(f.admin, 'GET', route(null, '?q=' + encodeURIComponent('合成核銷個案') + '&month=2026-10&status=verified&page=1&pageSize=1'));
  assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, item.id);
  const after = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(null, '?q=' + f.invoice.id))).body.total, 0); assert.deepEqual(f.raw(), after);
});

test('same-org batch with foreign/missing parents or unknown nested data is hidden from list/current/history/PATCH/export', async t => {
  const f = await fixture(t), foreign = await f.foreign(), item = await f.verify(await f.createBatch()), sql = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id), original = JSON.parse(sql.data);
  const variants = [
    value => { value.sourceSnapshots[0].unknown = { secret: 'SYNTHETIC-NESTED-SECRET' }; },
    value => { value.responses = [f.reply(f.invoice.id, { unknown: 'SYNTHETIC-NESTED-SECRET' })]; },
    value => { value.summary.extra = 'SYNTHETIC-NESTED-SECRET'; },
    value => { value.unknownTop = { secret: 'SYNTHETIC-NESTED-SECRET' }; },
    value => { value.sourceSnapshots[0].caseId = foreign.parentCase.id; },
    value => { value.billingDocumentIds[0] = foreign.invoice.id; value.sourceSnapshots[0].billingDocumentId = foreign.invoice.id; },
    value => { value.sourceSnapshots[0].billingDocumentId = randomUUID(); value.billingDocumentIds[0] = value.sourceSnapshots[0].billingDocumentId; },
    value => { value.summary.amountCents++; }, value => { value.sourceSnapshots[0].amountCents = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of variants) {
    const value = structuredClone(original); mutate(value); f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(value), item.id);
    const before = f.raw();
    for (const [method, path, payload] of [['GET', route(item)], ['GET', route(item, '/history')], ['GET', route(item, '/export?format=json')], ['PATCH', route(item), { version: item.version, note: '合成不可修復' }]]) {
      const result = await f.request(f.admin, method, path, payload); assert.equal(result.status, 404, result.text); assert.ok(!result.text.includes('SYNTHETIC-NESTED-SECRET')); assert.deepEqual(f.raw(), before);
    }
    const list = await f.request(f.admin, 'GET', route()); assert.equal(list.status, 200); assert.equal(list.body.total, 0); assert.deepEqual(f.raw(), before);
  }
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(sql.data, item.id);
  const invoiceSql = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(f.invoice.id), invoiceData = JSON.parse(invoiceSql.data);
  invoiceData.caseId = foreign.parentCase.id; invoiceData.caseSnapshot.id = foreign.parentCase.id;
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(invoiceData), f.invoice.id);
  const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(item))).status, 404); assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0); assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).status, 404); assert.deepEqual(f.raw(), before);
});

test('history filters null/invalid JSON, unknown snapshots, wrong SQL version and changed immutable identity without rewriting', async t => {
  const f = await fixture(t); let item = await f.createBatch(); item = await f.verify(item);
  const snapshot = { ...item, version: 3 };
  const invalid = ['null', '[]', '{invalid', JSON.stringify({ ...snapshot, version: 999 }), JSON.stringify({ ...snapshot, number: 'wrong-number' }), JSON.stringify({ ...snapshot, month: '2026-09' }),
    JSON.stringify({ ...snapshot, id: randomUUID() }), JSON.stringify({ ...snapshot, sourceSnapshots: [{ ...snapshot.sourceSnapshots[0], extra: 'SYNTHETIC-NESTED-SECRET' }] })];
  const statement = f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)');
  invalid.forEach((raw, index) => statement.run(f.admin.org, entity, item.id, index + 3, raw, item.updatedAt, 'synthetic-invalid-snapshot'));
  const before = f.raw(), result = await f.request(f.admin, 'GET', route(item, '/history?compare=previous'));
  assert.equal(result.status, 200, result.text); assert.equal(result.body.total, 2); assert.deepEqual(result.body.items.map(row => row.version), [2, 1]); assert.ok(!result.text.includes('SYNTHETIC-NESTED-SECRET')); assert.deepEqual(f.raw(), before);
});

test('JSON/CSV exports contain complete exact source and response data, safe header, UTF8 quoting and GET zero writes', async t => {
  const f = await fixture(t), beforeDraft = f.raw(), draft = await f.createBatch();
  const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(draft, '/export?format=csv'))).status, 409); assert.deepEqual(f.raw(), before);
  assert.equal(beforeDraft.records.filter(row => row.entity === entity).length, 0);
  let item = await f.verify(draft); item = await f.patch(entity, item, { status: 'reconciling', responseSourceReference: '  @共同,依據\r\n"文件"', responses: [f.reply(f.invoice.id, { reference: '=合成回應,\r\n"編號"', reason: '合成多行\r\n原因' })] });
  const frozen = f.raw(), json = await f.request(f.admin, 'GET', route(item, '/export?format=json'));
  assert.equal(json.status, 200); assert.equal(json.body.format, 'local-homecare-claim-v1'); assert.equal(json.body.officialSubmission, false); assert.equal(json.body.batch.version, item.version);
  assert.equal(json.body.lines[0].amountCents, 24003); assert.deepEqual(json.body.lines[0].response, item.responses[0]); assert.match(json.headers.get('content-disposition'), /attachment;.*\.json/); assert.match(json.headers.get('cache-control'), /no-store/); assert.deepEqual(f.raw(), frozen);
  const csv = await f.request(f.admin, 'GET', route(item, '/export?format=csv'));
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /^text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment;.*\.csv/); assert.match(csv.headers.get('cache-control'), /no-store/);
  assert.ok(csv.text.includes('"local-homecare-claim-v1"')); assert.ok(csv.text.includes('"24003"')); assert.ok(csv.text.includes('"accepted"'));
  assert.ok(csv.text.includes('"\'=合成回應,\r\n""編號"""')); assert.ok(csv.text.includes('"\'  @共同,依據\r\n""文件"""')); assert.ok(csv.text.includes('"合成多行\r\n原因"')); assert.deepEqual(f.raw(), frozen);
});

test('six complete 10000-character manual reasons save beyond 128KiB; over 4MiB and other entities still reject with zero writes', async t => {
  const f = await fixture(t), invoices = [f.invoice];
  for (let index = 0; index < 5; index++) invoices.push(await f.bill({ amount: 10001 + index }));
  let item = await f.verify(await f.createBatch({ billingDocumentIds: invoices.map(invoice => invoice.id) }));
  const responses = invoices.map((invoice, index) => f.reply(invoice.id, {
    reference: `合成完整回應 ${index + 1}`, amountCents: invoice.summary.amountCents,
    reason: `${index + 1}${'合'.repeat(9997)}末行`
  }));
  assert.ok(responses.every(response => response.reason.length === 10000));
  const payload = { version: item.version, status: 'reconciling', responseSourceReference: '合成大批回應文件', responses };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(payloadBytes > 131072); assert.ok(payloadBytes < 4 * 1024 * 1024);
  const saved = await f.request(f.admin, 'PATCH', route(item), payload);
  assert.equal(saved.status, 200, saved.text); item = saved.body.item;
  assert.equal(item.version, 3); assert.deepEqual(item.responses, responses);
  assert.equal(item.summary.acceptedAmountCents, invoices.reduce((amount, invoice) => amount + invoice.summary.amountCents, 0));
  const frozen = f.raw(), current = await f.request(f.admin, 'GET', route(item)), history = await f.request(f.admin, 'GET', route(item, '/history'));
  assert.equal(current.status, 200); assert.deepEqual(current.body.item.responses, responses);
  assert.equal(history.status, 200); assert.deepEqual(history.body.items[0].snapshot.responses, responses); assert.deepEqual(f.raw(), frozen);
  const oversized = { version: item.version, note: 'x'.repeat(4 * 1024 * 1024) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 4 * 1024 * 1024);
  const tooLarge = await f.request(f.admin, 'PATCH', route(item), oversized);
  assert.equal(tooLarge.status, 413, tooLarge.text); assert.deepEqual(f.raw(), frozen);
  const ordinaryTooLarge = await f.request(f.admin, 'PATCH', `/api/cases/${f.caseItem.id}`, { version: f.caseItem.version, note: 'x'.repeat(131073) });
  assert.equal(ordinaryTooLarge.status, 413, ordinaryTooLarge.text); assert.deepEqual(f.raw(), frozen);
});

test('CSV formula defense preserves commas/quotes/CRLF safely; sum checks use precise integer arithmetic', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', '  =1', '\t@x', '\r\n+1', '\uFEFF=1']) assert.equal(claimCsvCell(value), '"\'' + value.replace(/"/g, '""') + '"');
  assert.equal(claimCsvCell('合成,"引用"\r\n第二行'), '"合成,""引用""\r\n第二行"');
  const fail = (_status, _code, message) => { throw new Error(message); };
  const summary = claimBatchSummary([{ billingDocumentId: 'a', amountCents: Number.MAX_SAFE_INTEGER - 1 }, { billingDocumentId: 'b', amountCents: 1 }], [], fail);
  assert.equal(summary.amountCents, Number.MAX_SAFE_INTEGER);
  assert.throws(() => claimBatchSummary([{ billingDocumentId: 'a', amountCents: Number.MAX_SAFE_INTEGER }, { billingDocumentId: 'b', amountCents: 1 }], [], fail), /超過/);
});
