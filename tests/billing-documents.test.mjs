import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';

const bills = 'billing-documents', receipts = 'payment-receipts', password = 'synthetic-manual-billing-password';
const route = (entity, item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, data, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成人工帳單管理員', email: 'manual-billing@example.test', password, organizationName: '合成帳單機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  const create = async (entity, data, client = admin, headers = {}) => { const result = await request(client, 'POST', route(entity), data, headers); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const patch = async (entity, item, values, client = admin) => { const result = await request(client, 'PATCH', route(entity, item), { version: item.version, ...values }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const caseItem = await create('cases', { name: '合成帳單個案', caseNo: 'BILLING-CASE-01' });
  const employee = await create('employees', { name: '合成帳單員工', employeeNo: 'BILLING-EMP-01' });
  const clients = { admin };
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = `manual-billing-${role}@example.test`;
    await create('users', { name: '合成帳單' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const result = await request(null, 'POST', '/api/login', { email, password }); assert.equal(result.status, 200);
    clients[role] = { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: admin.org, user: result.body.user };
  }
  const bill = patch => ({ caseId: caseItem.id, month: '2026-10', number: 'MANUAL-01', lineItems: [{ label: '合成人工明細', quantity: 3, unitPriceCents: 1299 }], ...patch });
  const receipt = (parent, patch) => ({ billingDocumentId: parent.id, date: '2026-10-10', amountCents: 1000, method: 'cash', ...patch });
  const issued = async (values, client = admin) => { const item = await create(bills, bill(values), client); return patch(bills, item, { status: 'issued', sourceReference: '合成已核定人工計價依據' }, client); };
  const raw = () => { const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return { schema, tables: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name, app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()])) }; };
  const foreign = async () => {
    const organization = await create('organizations', { name: '合成帳單機構乙' }), client = { ...admin, org: organization.id };
    const caseItem = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'FOREIGN-CASE' }, client);
    const billItem = await create(bills, bill({ caseId: caseItem.id, number: 'FOREIGN-01' }), client);
    const issuedItem = await patch(bills, billItem, { status: 'issued', sourceReference: 'SYNTHETIC-FOREIGN-SOURCE' }, client);
    const receiptItem = await create(receipts, receipt(issuedItem), client);
    return { client, caseItem, billItem: issuedItem, receiptItem };
  };
  return { app, request, create, patch, admin, clients, caseItem, employee, bill, receipt, issued, raw, foreign };
}

test('admin and finance can manage bills and receipts with server amount and case snapshots', async t => {
  const f = await fixture(t);
  let bill = await f.create(bills, f.bill({ number: ' MANUAL-01 ', note: ' 原始\r\n備註 ' }), f.clients.finance);
  assert.equal(bill.number, 'MANUAL-01'); assert.equal(bill.status, 'draft'); assert.deepEqual(bill.summary, { amountCents: 3897 });
  assert.deepEqual(bill.caseSnapshot, { id: f.caseItem.id, name: f.caseItem.name, caseNo: f.caseItem.caseNo }); assert.equal(bill.note, ' 原始\r\n備註 ');
  bill = await f.patch(bills, bill, { status: 'issued', sourceReference: ' 合成依據 ' }, f.clients.finance); assert.equal(bill.sourceReference, '合成依據');
  const receipt = await f.create(receipts, f.receipt(bill), f.clients.finance); assert.equal(receipt.status, 'active');
  for (const client of [f.admin, f.clients.finance]) for (const [entity, item] of [[bills, bill], [receipts, receipt]]) {
    assert.equal((await f.request(client, 'GET', route(entity))).body.total, 1);
    assert.deepEqual((await f.request(client, 'GET', route(entity, item))).body.item, item);
    assert.equal((await f.request(client, 'GET', route(entity, item, '/history?compare=previous'))).status, 200);
  }
});
test('unauthorized roles get 403 before invalid queries bodies and all current/history mutations', async t => {
  const f = await fixture(t), bill = await f.issued(), receipt = await f.create(receipts, f.receipt(bill)), before = f.raw();
  for (const client of [f.clients.supervisor, f.clients.caregiver]) for (const [entity, item] of [[bills, bill], [receipts, receipt]]) {
    for (const target of [undefined, item, { id: randomUUID() }]) for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await f.request(client, method, route(entity, target, '?unknown=1'), method === 'GET' ? undefined : { unknown: true });
      assert.equal(response.status, 403); assert.equal(response.body.error.code, 'ROLE_FORBIDDEN');
    }
    assert.equal((await f.request(client, 'GET', route(entity, item, '/history?compare=wrong'))).status, 403);
  }
  assert.deepEqual(f.raw(), before);
});
test('current records list queries and history are isolated by organization and entity', async t => {
  const f = await fixture(t), bill = await f.issued(), receipt = await f.create(receipts, f.receipt(bill)), foreign = await f.foreign(), before = f.raw();
  for (const [entity, own, remote] of [[bills, bill, foreign.billItem], [receipts, receipt, foreign.receiptItem]]) {
    for (const suffix of ['', '/history', '/history?compare=previous']) {
      const result = await f.request(f.admin, 'GET', route(entity, remote, suffix)); assert.equal(result.status, 404); assert(!JSON.stringify(result.body).includes('SYNTHETIC-FOREIGN'));
      assert.equal((await f.request(foreign.client, 'GET', route(entity, own, suffix))).status, 404);
    }
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, remote), { version: remote.version, note: '越界' })).status, 404);
    assert.equal((await f.request(f.admin, 'GET', route(entity, f.employee))).status, 404);
    assert.equal((await f.request(f.admin, 'GET', route(entity))).body.total, 1);
  }
  assert.equal((await f.request(f.admin, 'GET', route(bills, undefined, '?caseId=' + foreign.caseItem.id))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route(receipts, undefined, '?billingDocumentId=' + foreign.billItem.id))).status, 404);
  assert.deepEqual(f.raw(), before);
});
test('creation validates complete closed line items strict cents references months and derived payload denial atomically', async t => {
  const f = await fixture(t), foreign = await f.foreign(), before = f.raw();
  const goodLine = f.bill().lineItems[0];
  const bad = [{ caseId: foreign.caseItem.id }, { caseId: '' }, { caseId: f.employee.id }, { month: '2026-13' }, { month: '0000-01' }, { month: '2026-1' },
    { number: ' ' }, { number: 'A\nB' }, { number: '字'.repeat(101) }, { lineItems: [] }, { lineItems: {} }, { lineItems: Array.from({ length: 101 }, () => goodLine) },
    { lineItems: [{ ...goodLine, quantity: 0 }] }, { lineItems: [{ ...goodLine, quantity: 10001 }] }, { lineItems: [{ ...goodLine, quantity: 1.1 }] },
    { lineItems: [{ ...goodLine, unitPriceCents: '1299' }] }, { lineItems: [{ ...goodLine, unitPriceCents: -1 }] }, { lineItems: [{ ...goodLine, unitPriceCents: 1000000001 }] },
    { lineItems: [{ ...goodLine, unitPriceCents: 1.1 }] }, { lineItems: [{ ...goodLine, label: ' ' }] }, { lineItems: [{ ...goodLine, label: 'A\nB' }] },
    { lineItems: [{ ...goodLine, amountCents: 3897 }] }, { summary: { amountCents: 1 } }, { caseSnapshot: {} }, { orgId: f.admin.org }, { version: 1 },
    { status: 'issued', sourceReference: '依據' }, { status: 'voided', note: '取消' }, { status: 'unapproved' }, { note: {} }, { sourceReference: '字'.repeat(2001) }];
  for (const patch of bad) { const result = await f.request(f.admin, 'POST', route(bills), f.bill(patch)); assert.equal(result.status, 422, JSON.stringify(patch)); }
  assert.deepEqual(f.raw(), before);
});
test('draft identity and number uniqueness are stable while editable lines recalculate exact amounts', async t => {
  const f = await fixture(t); let item = await f.create(bills, f.bill()); const before = f.raw();
  assert.equal((await f.request(f.admin, 'POST', route(bills), f.bill())).status, 409);
  for (const patch of [{ caseId: randomUUID() }, { month: '2026-11' }, { number: 'OTHER' }, { status: 'voided', note: '原因' }])
    assert([409, 422].includes((await f.request(f.admin, 'PATCH', route(bills, item), { version: item.version, ...patch })).status));
  assert.deepEqual(f.raw(), before);
  item = await f.patch(bills, item, { lineItems: [{ label: '合成精確明細', quantity: 10000, unitPriceCents: 1000000000 }], note: '調整草稿' });
  assert.equal(item.summary.amountCents, 10000000000000); assert.equal(item.version, 2);
});
test('draft saves capture current case identifiers and issued snapshots stay immutable on void', async t => {
  const f = await fixture(t); let item = await f.create(bills, f.bill());
  await f.patch('cases', f.caseItem, { name: '合成目前個案姓名' });
  item = await f.patch(bills, item, { status: 'issued', sourceReference: '人工依據' }); assert.equal(item.caseSnapshot.name, '合成目前個案姓名');
  const currentCase = (await f.request(f.admin, 'GET', route('cases', f.caseItem))).body.item;
  await f.patch('cases', currentCase, { name: '合成開立後姓名' });
  const cancelled = await f.patch(bills, item, { status: 'voided', note: '合成人工取消' }); assert.deepEqual(cancelled.caseSnapshot, item.caseSnapshot);
  const history = (await f.request(f.admin, 'GET', route(bills, item, '/history?compare=previous'))).body.items;
  assert.equal(history.length, 3); assert.equal(history[2].snapshot.caseSnapshot.name, '合成帳單個案');
});
test('issue requires explicit source and locks every original bill field including notes', async t => {
  const f = await fixture(t); let item = await f.create(bills, f.bill({ note: '舊備註' })); let before = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(bills, item), { version: item.version, status: 'issued' })).status, 422); assert.deepEqual(f.raw(), before);
  item = await f.patch(bills, item, { status: 'issued', sourceReference: '核定依據' }); before = f.raw();
  for (const patch of [{ status: 'draft' }, { note: '改備註' }, { sourceReference: '改來源' }, { lineItems: [{ label: '改', quantity: 1, unitPriceCents: 1 }] },
    { status: 'voided' }, { status: 'voided', note: ' ' }, { status: 'voided', note: '原因', sourceReference: '改來源' }])
    assert([409, 422].includes((await f.request(f.admin, 'PATCH', route(bills, item), { version: item.version, ...patch })).status));
  assert.deepEqual(f.raw(), before);
  item = await f.patch(bills, item, { status: 'voided', note: '本次作廢' }); before = f.raw();
  for (const patch of [{ note: '更正作廢' }, { status: 'draft' }, { status: 'voided', note: '再作廢' }]) assert.equal((await f.request(f.admin, 'PATCH', route(bills, item), { version: item.version, ...patch })).status, 409);
  assert.equal((await f.request(f.admin, 'POST', route(bills), f.bill())).status, 409); assert.deepEqual(f.raw(), before);
});
test('receipt validation requires issued local parent actual dates strict cents and approved methods with zero writes', async t => {
  const f = await fixture(t), draft = await f.create(bills, f.bill()), item = await f.issued({ number: 'MANUAL-02' }), foreign = await f.foreign(), before = f.raw();
  const bad = [{ billingDocumentId: foreign.billItem.id }, { billingDocumentId: f.caseItem.id }, { billingDocumentId: '' }, { date: '2026-02-29' }, { date: '0000-01-01' },
    { amountCents: '1' }, { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.2 }, { amountCents: 1000000001 }, { method: 'card' },
    { status: 'cancelled', note: '原因' }, { status: 'draft' }, { note: [] }, { reference: '字'.repeat(501) }, { summary: {} }, { version: 1 }];
  for (const patch of bad) assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(item, patch))).status, 422, JSON.stringify(patch));
  assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(draft))).status, 409);
  assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(item, { amountCents: 3898 }))).body.error.code, 'OVERPAYMENT'); assert.deepEqual(f.raw(), before);
});
test('receipts can only be cancelled with a new reason and remain immutable with precise version history', async t => {
  const f = await fixture(t), bill = await f.issued(); let receipt = await f.create(receipts, f.receipt(bill, { note: '不可重用舊備註' })); let before = f.raw();
  for (const patch of [{ status: 'cancelled' }, { status: 'cancelled', note: ' ' }, { amountCents: 1001 }, { date: '2026-10-11' },
    { method: 'transfer' }, { note: '改備註' }, { status: 'cancelled', note: '原因', amountCents: 1001 }])
    assert([409, 422].includes((await f.request(f.admin, 'PATCH', route(receipts, receipt), { version: receipt.version, ...patch })).status));
  assert.deepEqual(f.raw(), before);
  receipt = await f.patch(receipts, receipt, { status: 'cancelled', note: '本次取消原因' }, f.clients.finance); before = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(receipts, receipt), { version: receipt.version, status: 'active' })).status, 409);
  assert.equal((await f.request(f.admin, 'DELETE', route(receipts, receipt))).status, 404); assert.deepEqual(f.raw(), before);
  const history = (await f.request(f.admin, 'GET', route(receipts, receipt, '/history?compare=previous'))).body.items;
  assert.equal(history.length, 2); assert.equal(history[0].comparison.previousSnapshot.status, 'active'); assert.equal(history[0].snapshot.status, 'cancelled');
  const previous = history[0].comparison.previousSnapshot;
  for (const key of ['billingDocumentId', 'date', 'amountCents', 'method', 'reference']) assert.deepEqual(history[0].snapshot[key], previous[key]);
  assert.equal(previous.note, '不可重用舊備註'); assert.equal(history[0].snapshot.note, '本次取消原因');
});
test('active receipts prevent bill voiding cancellation restores capacity and no bank or bill mutation occurs', async t => {
  const f = await fixture(t), bill = await f.issued(), receipt = await f.create(receipts, f.receipt(bill, { amountCents: 3897 })); let before = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(bills, bill), { version: bill.version, status: 'voided', note: '原因' })).body.error.code, 'ACTIVE_RECEIPTS');
  assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(bill, { amountCents: 1 }))).body.error.code, 'OVERPAYMENT'); assert.deepEqual(f.raw(), before);
  await f.patch(receipts, receipt, { status: 'cancelled', note: '收款取消' });
  assert.deepEqual((await f.request(f.admin, 'GET', route(bills, bill))).body.item, bill);
  const final = await f.patch(bills, bill, { status: 'voided', note: '作廢原因' }); assert.equal(final.status, 'voided');
  assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(final))).status, 409);
});
test('concurrent receipt creation serializes total validation and rejects overpayment atomically', async t => {
  const f = await fixture(t), bill = await f.issued({ lineItems: [{ label: '合成上限', quantity: 1, unitPriceCents: 10000 }] });
  const outputs = await Promise.all(['A', 'B'].map(reference => f.request(f.admin, 'POST', route(receipts), f.receipt(bill, { amountCents: 6000, reference }), { 'Idempotency-Key': randomUUID() })));
  assert.deepEqual(outputs.map(result => result.status).sort(), [201, 409]); assert.equal(outputs.find(result => result.status === 409).body.error.code, 'OVERPAYMENT');
  const list = (await f.request(f.admin, 'GET', route(receipts, undefined, '?billingDocumentId=' + bill.id))).body;
  assert.equal(list.total, 1); assert.equal(list.items[0].amountCents, 6000);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM record_versions WHERE entity=?').get(receipts).n, 1);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM audit WHERE entity=?').get(receipts).n, 1);
});
test('create idempotency duplicate conflicts stale CAS and CSRF cannot duplicate writes or lose saved history', async t => {
  const f = await fixture(t), key = randomUUID(), payload = f.bill();
  const first = await f.request(f.admin, 'POST', route(bills), payload, { 'Idempotency-Key': key }), before = f.raw(); assert.equal(first.status, 201);
  const replay = await f.request(f.admin, 'POST', route(bills), payload, { 'Idempotency-Key': key }); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.raw(), before);
  assert.equal((await f.request(f.admin, 'POST', route(bills), f.bill({ number: 'OTHER' }), { 'Idempotency-Key': key })).status, 409);
  assert.equal((await f.request({ ...f.admin, csrf: 'wrong' }, 'POST', route(bills), f.bill({ number: 'CSRF' }))).status, 403); assert.deepEqual(f.raw(), before);
  const item = first.body.item, updated = await f.patch(bills, item, { note: '有版本保存' }), after = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(bills, item), { version: item.version, note: '過期覆寫' })).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(f.admin, 'PATCH', route(bills, item), { note: '無版本覆寫' })).status, 422); assert.deepEqual(f.raw(), after);
  const issued = await f.patch(bills, updated, { status: 'issued', sourceReference: '依據' }), receiptKey = randomUUID(), receiptData = f.receipt(issued);
  const receipt = await f.request(f.admin, 'POST', route(receipts), receiptData, { 'Idempotency-Key': receiptKey }), receiptBefore = f.raw();
  const receiptReplay = await f.request(f.admin, 'POST', route(receipts), receiptData, { 'Idempotency-Key': receiptKey }); assert.deepEqual(receiptReplay.body, receipt.body); assert.deepEqual(f.raw(), receiptBefore);
});
test('strict lists have precise filters and business-only text search without IDs snapshots or hidden fields', async t => {
  const f = await fixture(t), item = await f.issued({ number: 'MANUAL-MATCH', note: 'SYNTHETIC-NOTE' }), receipt = await f.create(receipts, f.receipt(item, { reference: 'SYNTHETIC-REFERENCE' }));
  for (const q of ['MANUAL-MATCH', 'SYNTHETIC-NOTE']) assert.equal((await f.request(f.admin, 'GET', route(bills, undefined, '?q=' + q))).body.total, 1);
  for (const q of [item.id, f.caseItem.id, f.caseItem.name, f.caseItem.caseNo, '合成人工明細']) assert.equal((await f.request(f.admin, 'GET', route(bills, undefined, '?q=' + encodeURIComponent(q)))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', route(receipts, undefined, '?q=SYNTHETIC-REFERENCE'))).body.total, 1);
  assert.equal((await f.request(f.admin, 'GET', route(receipts, undefined, '?q=' + receipt.id))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', route(receipts, undefined, '?month=2026-10&caseId=' + f.caseItem.id + '&billingDocumentId=' + item.id))).body.total, 1);
  for (const entity of [bills, receipts]) for (const query of ['?page=0', '?page=01', '?pageSize=101', '?q=' + 'x'.repeat(201), '?status=', '?month=2026-13', '?unknown=1', '?page=1&page=2', '?caseId=', '?compare=previous'])
    assert.equal((await f.request(f.admin, 'GET', route(entity, undefined, query))).status, 422, entity + query);
  assert.equal((await f.request(f.admin, 'GET', route(bills, item, '?q=anything'))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', route(bills, item, '/history?status=draft'))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', route(receipts, receipt, '/history?compare=next'))).status, 422);
});
test('current and history hide saved bills and receipts whose current case reference crosses organizations', async t => {
  const f = await fixture(t), item = await f.issued(), receipt = await f.create(receipts, f.receipt(item)), foreign = await f.foreign();
  const changed = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
  changed.caseId = foreign.caseItem.id; changed.caseSnapshot = { id: foreign.caseItem.id, name: 'SYNTHETIC-FOREIGN-SNAPSHOT', caseNo: 'FOREIGN-CASE' };
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(changed), item.id); const before = f.raw();
  for (const [entity, row] of [[bills, item], [receipts, receipt]]) {
    assert.equal((await f.request(f.admin, 'GET', route(entity))).body.total, 0);
    for (const suffix of ['', '/history?compare=previous']) { const response = await f.request(f.admin, 'GET', route(entity, row, suffix)); assert.equal(response.status, 404); assert(!JSON.stringify(response.body).includes('FOREIGN')); }
    const response = await f.request(f.admin, 'PATCH', route(entity, row), { version: row.version, status: entity === bills ? 'voided' : 'cancelled', note: '越界取消' }); assert.equal(response.status, 404);
  }
  assert.equal((await f.request(f.admin, 'GET', route(receipts, undefined, '?billingDocumentId=' + item.id))).status, 404);
  assert.equal((await f.request(f.admin, 'POST', route(receipts), f.receipt(item, { amountCents: 1 }))).status, 422); assert.deepEqual(f.raw(), before);
});
test('historical parent identities and SQL versions must match without revealing foreign saved snapshot text', async t => {
  const f = await fixture(t), item = await f.issued(), receipt = await f.create(receipts, f.receipt(item)), foreign = await f.foreign();
  const insertVersion = (entity, current, version, patch) => f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)')
    .run(f.admin.org, entity, current.id, version, JSON.stringify({ ...current, version, ...patch }), current.updatedAt, 'synthetic-invalid-snapshot');
  insertVersion(bills, item, 50, { caseId: foreign.caseItem.id, caseSnapshot: { id: foreign.caseItem.id, name: 'SYNTHETIC-FOREIGN-HISTORY', caseNo: 'FOREIGN' } });
  insertVersion(bills, item, 51, { version: 52, note: 'SYNTHETIC-FOREIGN-VERSION' });
  insertVersion(receipts, receipt, 50, { billingDocumentId: foreign.billItem.id, note: 'SYNTHETIC-FOREIGN-RECEIPT' }); const before = f.raw();
  for (const [entity, row, expected] of [[bills, item, 2], [receipts, receipt, 1]]) {
    const response = await f.request(f.admin, 'GET', route(entity, row, '/history?compare=previous')); assert.equal(response.status, 200); assert.equal(response.body.total, expected);
    assert(!JSON.stringify(response.body).includes('SYNTHETIC-FOREIGN'));
  }
  assert.deepEqual(f.raw(), before);
});

test('unknown nested case snapshot fields hide bill and dependent receipts across current list history and patch', async t => {
  const f = await fixture(t), item = await f.issued(), receipt = await f.create(receipts, f.receipt(item));
  const data = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
  data.caseSnapshot.extra = { privateText: 'SYNTHETIC-UNAPPROVED-NESTED-SNAPSHOT' };
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data), item.id); const before = f.raw();
  for (const client of [f.admin, f.clients.finance]) {
    for (const [entity, row, targetStatus] of [[bills, item, 'voided'], [receipts, receipt, 'cancelled']]) {
      const list = await f.request(client, 'GET', route(entity)); assert.equal(list.status, 200); assert.equal(list.body.total, 0);
      assert(!JSON.stringify(list.body).includes('SYNTHETIC-UNAPPROVED'));
      for (const suffix of ['', '/history', '/history?compare=previous']) {
        const response = await f.request(client, 'GET', route(entity, row, suffix)); assert.equal(response.status, 404);
        assert(!JSON.stringify(response.body).includes('SYNTHETIC-UNAPPROVED'));
      }
      assert.equal((await f.request(client, 'PATCH', route(entity, row), { version: row.version, status: targetStatus, note: '不得操作不完整快照' })).status, 404);
    }
    assert.equal((await f.request(client, 'GET', route(receipts, undefined, '?billingDocumentId=' + item.id))).status, 404);
    assert.equal((await f.request(client, 'POST', route(receipts), f.receipt(item, { amountCents: 1 }))).status, 422);
  }
  assert.deepEqual(f.raw(), before);
});

test('unknown nested historical case snapshot fields are filtered without corrupting legitimate exact previous comparisons', async t => {
  const f = await fixture(t), item = await f.issued(), receipt = await f.create(receipts, f.receipt(item));
  const invalid = { ...item, version: 50, caseSnapshot: { ...item.caseSnapshot, extra: { privateText: 'SYNTHETIC-UNAPPROVED-HISTORICAL-SNAPSHOT' } } };
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, bills, item.id, 50, JSON.stringify(invalid), item.updatedAt, 'synthetic-unapproved-snapshot');
  const before = f.raw();
  for (const client of [f.admin, f.clients.finance]) {
    const history = await f.request(client, 'GET', route(bills, item, '/history?compare=previous')); assert.equal(history.status, 200); assert.equal(history.body.total, 2);
    assert.equal(history.body.items[0].version, 2); assert.equal(history.body.items[0].comparison.previousVersion, 1);
    assert.equal(history.body.items[0].comparison.previousSnapshot.status, 'draft'); assert(!JSON.stringify(history.body).includes('SYNTHETIC-UNAPPROVED'));
    assert.deepEqual((await f.request(client, 'GET', route(bills, item))).body.item, item);
    assert.deepEqual((await f.request(client, 'GET', route(receipts, receipt))).body.item, receipt);
    assert.equal((await f.request(client, 'GET', route(receipts, receipt, '/history?compare=previous'))).body.total, 1);
  }
  assert.deepEqual(f.raw(), before);
});
