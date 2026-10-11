import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { claimBatchSummary } from '../src/server/claim-batches.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { claimSummary, claimSummaryForDisplay, claimResponsesForDisplay, claimUnconfirmedAmountCents, checkClaimBatchRecord, createClaimResponseEditor } from '../public/data/claim-batch-editor.js';
import { normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const source = (changes = {}) => ({ billingDocumentId: 'synthetic-bill', version: 2, number: 'SYN-BILL', caseId: 'synthetic-case', caseName: '合成個案', amountCents: 10001, ...changes });
const reply = (changes = {}) => ({ billingDocumentId: 'synthetic-bill', reference: '合成回應依據', status: 'partial', amountCents: 3001, reason: '合成人工已核部分，餘額仍待確認', ...changes });
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const record = (changes = {}) => { const sourceSnapshots = changes.sourceSnapshots || [source()], responses = changes.responses || [reply()]; return {
  month: '2026-10', number: 'SYN-PARTIAL', billingDocumentIds: sourceSnapshots.map(s => s.billingDocumentId), sourceReference: '合成核對原額', responseSourceReference: '合成回應文件', responses,
  status: 'reconciling', note: '', sourceSnapshots, summary: claimSummary(sourceSnapshots, responses), id: 'synthetic-batch', orgId: 'synthetic-org', version: 3, createdAt: '2026-10-12T01:00:00.000Z', updatedAt: '2026-10-12T01:00:00.000Z', ...changes }; };

test('partial splits cumulative recognized cents and unresolved difference into the exact legacy seven-key summary', () => {
  const sources = [source(), source({ billingDocumentId: 'b2', amountCents: 201 }), source({ billingDocumentId: 'b3', amountCents: 101 }), source({ billingDocumentId: 'b4', amountCents: 103 }), source({ billingDocumentId: 'b5', amountCents: 107 })];
  const responses = [reply(), reply({ billingDocumentId: 'b2', status: 'accepted', amountCents: 201, reason: '' }), reply({ billingDocumentId: 'b3', status: 'rejected', amountCents: 0 }), reply({ billingDocumentId: 'b4', status: 'pending', amountCents: 0, reason: '' })];
  const expected = { amountCents: 10513, acceptedAmountCents: 3202, rejectedAmountCents: 101, pendingAmountCents: 7103, unansweredAmountCents: 107, sourceCount: 5, responseCount: 4 };
  assert.deepEqual(claimSummary(sources, responses), expected); assert.deepEqual(claimBatchSummary(sources, responses, fail), expected); assert.deepEqual(claimSummaryForDisplay(expected), expected);
  assert.equal(claimUnconfirmedAmountCents(source(), reply()), 7000); assert.equal(claimUnconfirmedAmountCents(source(), undefined), 10001);
  assert.equal(claimUnconfirmedAmountCents(source(), reply({ status: 'rejected', amountCents: 0 })), 0);
});
for (const cents of [1, 10000, Number.MAX_SAFE_INTEGER - 1]) test('partial exact boundary cents ' + cents, () => {
  const amount = cents === Number.MAX_SAFE_INTEGER - 1 ? Number.MAX_SAFE_INTEGER : 10001, s = source({ amountCents: amount }), r = reply({ amountCents: cents });
  const result = claimSummary([s], [r]); assert.equal(result.acceptedAmountCents, cents); assert.equal(result.pendingAmountCents, amount - cents); assert.deepEqual(claimBatchSummary([s], [r], fail), result);
});
test('partial zero/full/negative/fraction/string/overflow/blank evidence/unknown fields fail while legacy short accepted still fails', () => {
  for (const change of [{ amountCents: 0 }, { amountCents: 10001 }, { amountCents: -1 }, { amountCents: 1.1 }, { amountCents: '1' }, { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { reason: ' ' }, { reference: '' }, { unknown: true }, { status: 'accepted', amountCents: 10000 }]) {
    assert.throws(() => claimSummary([source()], [reply(change)])); assert.throws(() => claimBatchSummary([source()], [reply(change)], fail));
  }
  assert.throws(() => claimSummary([source({ amountCents: Number.MAX_SAFE_INTEGER }), source({ billingDocumentId: 'b2', amountCents: 1 })], [reply()]));
});
test('partial typed history requires validated source bounds; accessors never execute, and legacy projection stays unchanged', () => {
  let calls = 0; const bad = reply(); Object.defineProperty(bad, 'amountCents', { enumerable: true, get() { calls++; return 3; } });
  assert.equal(claimResponsesForDisplay([bad], [source()]), null); assert.equal(calls, 0);
  assert.equal(claimResponsesForDisplay([reply()]), null); assert.equal(claimResponsesForDisplay([reply()], [source({ amountCents: 2 })]), null);
  assert.deepEqual(claimResponsesForDisplay([reply()], [source()]), [reply()]);
  const legacy = reply({ status: 'accepted', amountCents: 10001, reason: '' }); assert.deepEqual(claimResponsesForDisplay([legacy]), [legacy]);
  const before = record(), after = record({ responses: [reply({ amountCents: 4001 })] });
  const projection = normalizeHistorySnapshot('claim-batches', before); assert.deepEqual(projection.responses, [{ ...before.responses[0], sourceAmountCents: 10001, unconfirmedAmountCents: 7000 }]); assert.deepEqual(projection.sourceSnapshots, before.sourceSnapshots);
  assert.equal(projection.summary.find(r => r.label === '尚待確認差額（含待定）').value, 7000);
  assert(diffHistorySnapshots('claim-batches', before, after).some(r => r.key === 'responses'));
  assert.throws(() => checkClaimBatchRecord({ item: { ...before, status: 'closed' } }, { orgId: before.orgId }));
});
test('editor replaces cumulative value, preserves other replies and original multiline bytes, and preview never rounds', () => {
  const s2 = source({ billingDocumentId: 'second-bill', number: 'B2' }), old = reply({ reference: '  合成\r\n依據  ', reason: '  合成\r\n說明  ' });
  const existing = record({ sourceSnapshots: [source(), s2], responses: [old, reply({ billingDocumentId: s2.billingDocumentId })] });
  const editor = createClaimResponseEditor(existing, 'synthetic-bill'); assert.deepEqual(editor.buildPayload(editor.initialDisplay), {});
  assert.equal(editor.sourceAmountCents, 10001); assert.equal(editor.previewUnconfirmedAmountCents({ ...editor.initialDisplay, amount: '40.01' }), 6000);
  const payload = editor.buildPayload({ ...editor.initialDisplay, amount: '40.01' }); assert.equal(payload.responses[0].amountCents, 4001); assert.equal(payload.responses[0].reason, old.reason); assert.equal(payload.responses[0].reference, old.reference); assert.deepEqual(payload.responses[1], existing.responses[1]);
  assert.equal(claimSummary(existing.sourceSnapshots, payload.responses).acceptedAmountCents, 7002); // 4001 + 3001, never 3001 + 4001 + 3001.
  for (const amount of ['0', '100.01', '3.001', '1e2', '-1', 'NaN']) { assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, amount })); assert.equal(editor.previewUnconfirmedAmountCents({ ...editor.initialDisplay, amount }), null); }
  assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, reason: '' }));
  for (const status of ['accepted', 'pending']) assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, status, amount: status === 'accepted' ? '100.01' : '0', reason: ' ' }));
});
test('partial ACK rejects wrong org/id/version/amount/summary/frozen source rather than treating HTTP success as saved', () => {
  const original = record(), payload = { responses: [reply({ amountCents: 4001 })] }, saved = record({ responses: payload.responses, version: 4 });
  assert.equal(checkClaimBatchRecord({ item: saved }, { orgId: original.orgId, id: original.id, original, payload }), saved);
  for (const change of [{ orgId: 'foreign' }, { id: 'wrong' }, { version: 3 }, { responses: [reply()] }, { summary: { ...saved.summary, pendingAmountCents: 7000 } }, { sourceSnapshots: [source({ amountCents: 10002 })] }])
    assert.throws(() => checkClaimBatchRecord({ item: { ...saved, ...change } }, { orgId: original.orgId, id: original.id, original, payload }));
});

const snapshot = db => ({ changes: db.prepare('SELECT total_changes() n').get().n,
  tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])) });
async function fixture(t, { portalStorage = false } = {}) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close()); assert.notEqual(new URL(base).port, '4310');
  if (portalStorage) initPortalStorage(app.db);
  const password = 'synthetic-partial-only';
  const request = async (client, method, route, data, key) => { const r = await fetch(base + route, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.auth.csrfToken } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = null; } return { status: r.status, body, text, headers: r.headers }; };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成部分核付管理員', email: 'partial-admin@example.invalid', password, organizationName: '合成部分核付甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], auth: setup.body, org: setup.body.organizations[0].id };
  const post = async (entity, data, client = admin) => { const r = await request(client, 'POST', '/api/' + entity, data, randomUUID()); assert.equal(r.status, 201, r.text); return r.body.item; };
  const patch = async (entity, item, data, client = admin, key = randomUUID()) => { const r = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data }, key); assert.equal(r.status, 200, r.text); return r.body.item; };
  const employee = await post('employees', { name: '合成部分核付員工', employeeNo: 'PART-E' }), caseItem = await post('cases', { name: '合成部分核付個案', caseNo: 'PART-C' });
  const clients = { admin };
  for (const role of ['admin', 'finance', 'supervisor', 'caregiver']) { const user = await post('users', { name: '合成第二' + role, email: role + '@partial.example.invalid', password, role, employeeId: role === 'caregiver' ? employee.id : null }); const login = await request(null, 'POST', '/api/login', { email: user.email, password }); assert.equal(login.status, 200); clients[role === 'admin' ? 'manager' : role] = { cookie: login.headers.get('set-cookie').split(';')[0], auth: login.body, org: admin.org }; }
  let bill = await post('billing-documents', { caseId: caseItem.id, month: '2026-10', number: 'PART-B', lineItems: [{ label: '合成人工原額', quantity: 1, unitPriceCents: 10001 }] }); bill = await patch('billing-documents', bill, { status: 'issued', sourceReference: '合成計價依據' });
  let batch = await post('claim-batches', { month: '2026-10', number: 'PART-CB', billingDocumentIds: [bill.id], sourceReference: '合成核對原額' }); batch = await patch('claim-batches', batch, { status: 'verified' });
  const response = changes => reply({ billingDocumentId: bill.id, ...changes });
  const save = (item, amount, client = admin) => patch('claim-batches', item, { status: 'reconciling', responseSourceReference: '合成收到回應', responses: [response({ amountCents: amount })] }, client);
  const deny = async (client, method, route, data, status, key = randomUUID()) => { const before = snapshot(app.db), r = await request(client, method, route, data, key); assert.equal(r.status, status, r.text); assert.deepEqual(snapshot(app.db), before); return r; };
  return { app, base, request, post, patch, admin, clients, caseItem, bill, batch, response, save, deny };
}
test('real HTTP admin/finance cumulative edit preserves bill/version/audit, seven-key history, and requires explicit full result to close', async t => {
  const f = await fixture(t), schemaBefore = f.app.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), billBefore = f.app.db.prepare("SELECT * FROM records WHERE entity='billing-documents'").all(), billVersions = f.app.db.prepare("SELECT * FROM record_versions WHERE entity='billing-documents'").all();
  let batch = await f.save(f.batch, 3001, f.clients.finance); const frozen = structuredClone(batch.sourceSnapshots);
  assert.equal(batch.version, 3); assert.equal(batch.summary.acceptedAmountCents, 3001); assert.equal(batch.summary.pendingAmountCents, 7000); assert.equal(Object.keys(batch.summary).length, 7);
  await f.deny(f.admin, 'PATCH', '/api/claim-batches/' + batch.id, { version: batch.version, status: 'closed' }, 409);
  batch = await f.save(batch, 4001); assert.equal(batch.summary.acceptedAmountCents, 4001); assert.equal(batch.summary.pendingAmountCents, 6000); assert.deepEqual(batch.sourceSnapshots, frozen);
  const beforeReads = snapshot(f.app.db), history = await f.request(f.clients.finance, 'GET', '/api/claim-batches/' + batch.id + '/history?compare=previous'); assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.slice(0, 2).map(row => row.snapshot.responses[0].amountCents), [4001, 3001]); assert(history.body.items.every(row => Object.keys(row.snapshot.summary).length === 7)); assert.deepEqual(snapshot(f.app.db), beforeReads);
  batch = await f.patch('claim-batches', batch, { responses: [f.response({ status: 'accepted', amountCents: 10001, reason: '合成最新明確全額回應' })] }); batch = await f.patch('claim-batches', batch, { status: 'closed' }); assert.equal(batch.summary.acceptedAmountCents, 10001); assert.equal(batch.summary.pendingAmountCents, 0);
  assert.deepEqual(f.app.db.prepare("SELECT * FROM records WHERE entity='billing-documents'").all(), billBefore); assert.deepEqual(f.app.db.prepare("SELECT * FROM record_versions WHERE entity='billing-documents'").all(), billVersions);
  // Local auth initializes 11 tables; Portal adds its existing two. This slice creates none.
  assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), schemaBefore);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM audit WHERE entity='claim-batches' AND record_id=?").get(batch.id).n, 6);
});
test('existing Portal 13-table six-trigger schema is unchanged by partial facts; history and BLOB protections remain present', async t => {
  const f = await fixture(t, { portalStorage: true }), before = f.app.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(before.filter(row => row.type === 'table').length, 13); assert.equal(before.filter(row => row.type === 'trigger').length, 6);
  await f.save(f.batch, 1);
  assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), before);
});
test('HTTP partial violations, legacy short accepted, unknown/duplicate/foreign responses and CAS all reject with zero SQL changes', async t => {
  const f = await fixture(t), route = '/api/claim-batches/' + f.batch.id;
  for (const changes of [{ amountCents: 0 }, { amountCents: 10001 }, { amountCents: -1 }, { amountCents: 3001.1 }, { amountCents: '3001' }, { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { reason: '' }, { reference: '' }, { extra: true }, { status: 'accepted', amountCents: 3001 }, { billingDocumentId: randomUUID() }])
    await f.deny(f.admin, 'PATCH', route, { version: f.batch.version, status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response(changes)] }, 422);
  await f.deny(f.admin, 'PATCH', route, { version: f.batch.version, status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response({}), f.response({})] }, 422);
  const batch = await f.save(f.batch, 1); await f.deny(f.admin, 'PATCH', route, { version: f.batch.version, responses: batch.responses }, 409);
  await f.deny(f.admin, 'PATCH', route, { version: batch.version, summary: batch.summary }, 422);
});
test('HTTP all four roles and cross-org boundaries deny partial read/write/export/history without writes', async t => {
  const f = await fixture(t), batch = await f.save(f.batch, 3001), route = '/api/claim-batches/' + batch.id;
  for (const role of ['supervisor', 'caregiver']) for (const [method, suffix, data] of [['GET', '', undefined], ['GET', '/history', undefined], ['GET', '/export?format=json', undefined], ['PATCH', '', { version: batch.version, responses: batch.responses }]]) await f.deny(f.clients[role], method, route + suffix, data, 403);
  const org = await f.post('organizations', { name: '合成另一機構' }), foreign = { ...f.admin, org: org.id };
  for (const suffix of ['', '/history', '/export?format=json']) await f.deny(foreign, 'GET', route + suffix, undefined, 404);
  await f.deny(foreign, 'PATCH', route, { version: batch.version, responses: batch.responses }, 404);
  assert.equal((await f.request(f.clients.finance, 'GET', route)).status, 200);
});
test('HTTP idem same payload returns exact ACK with zero writes; key conflict and stale ACK decline without double counting', async t => {
  const f = await fixture(t), route = '/api/claim-batches/' + f.batch.id, key = randomUUID(), payload = { version: f.batch.version, status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response({})] };
  const first = await f.request(f.admin, 'PATCH', route, payload, key); assert.equal(first.status, 200, first.text); const before = snapshot(f.app.db), second = await f.request(f.admin, 'PATCH', route, payload, key); assert.equal(second.status, 200); assert.deepEqual(second.body, first.body); assert.deepEqual(snapshot(f.app.db), before);
  await f.deny(f.admin, 'PATCH', route, { ...payload, responses: [f.response({ amountCents: 4001 })] }, 409, key);
  await f.save(first.body.item, 4001); const stale = await f.deny(f.admin, 'PATCH', route, payload, 409, key); assert.equal(stale.body.error.code, 'CLAIM_RECEIPT_STALE');
});
test('HTTP v2 partial exports expose original/cumulative/unconfirmed cents and formula safety; legacy current v1 returns after explicit full result', async t => {
  const f = await fixture(t); let batch = await f.patch('claim-batches', f.batch, { status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response({ reference: '=合成回應', amountCents: 1 })] });
  const before = snapshot(f.app.db), json = await f.request(f.admin, 'GET', '/api/claim-batches/' + batch.id + '/export?format=json'), csv = await f.request(f.admin, 'GET', '/api/claim-batches/' + batch.id + '/export?format=csv');
  assert.equal(json.status, 200); assert.equal(json.body.format, 'local-homecare-claim-v2'); assert.equal(json.body.officialSubmission, false); assert.equal(json.body.lines[0].amountCents, 10001); assert.equal(json.body.lines[0].response.amountCents, 1); assert.equal(json.body.lines[0].unconfirmedAmountCents, 10000);
  assert.equal(csv.status, 200); assert(csv.text.includes('unconfirmedAmountCents')); assert(csv.text.includes('"\'=合成回應"')); assert(csv.text.includes('local-homecare-claim-v2')); assert.match(json.body.warning, /非本次新增款項/); assert.deepEqual(snapshot(f.app.db), before);
  batch = await f.patch('claim-batches', batch, { responses: [f.response({ status: 'accepted', amountCents: 10001, reason: '合成後續明確全額回應' })] }); const legacy = await f.request(f.admin, 'GET', '/api/claim-batches/' + batch.id + '/export?format=json'); assert.equal(legacy.body.format, 'local-homecare-claim-v1'); assert.equal(Object.hasOwn(legacy.body.lines[0], 'unconfirmedAmountCents'), false);
  const history = await f.request(f.admin, 'GET', '/api/claim-batches/' + batch.id + '/history'); assert.equal(history.body.items[1].snapshot.responses[0].status, 'partial');
});
for (const status of ['accepted', 'pending']) test('HTTP correcting an existing partial to ' + status + ' requires explanation; legacy accepted without explanation stays valid', async t => {
  const f = await fixture(t); let batch = await f.save(f.batch, 3001), amountCents = status === 'accepted' ? 10001 : 0;
  for (const reason of ['', ' ']) { const r = await f.deny(f.admin, 'PATCH', '/api/claim-batches/' + batch.id, { version: batch.version, responses: [f.response({ status, amountCents, reason })] }, 422); assert.equal(r.body.error.code, 'RESPONSE_CHANGE_REASON_REQUIRED'); }
  batch = await f.patch('claim-batches', batch, { responses: [f.response({ status, amountCents, reason: '合成對原部分事實的後續明確說明' })] }); assert.equal(batch.responses[0].status, status);
  const history = await f.request(f.admin, 'GET', '/api/claim-batches/' + batch.id + '/history'); assert.equal(history.body.items[1].snapshot.responses[0].status, 'partial');
  const g = await fixture(t); const legacy = await g.patch('claim-batches', g.batch, { status: 'reconciling', responseSourceReference: '合成普通全額回應', responses: [g.response({ status: 'accepted', amountCents: 10001, reason: '' })] }); assert.equal(legacy.responses[0].reason, '');
});
test('HTTP an existing partial cannot be silently omitted in a multi-source response replacement; cancellation retains facts and legacy omission stays valid', async t => {
  const f = await fixture(t); await f.patch('claim-batches', f.batch, { status: 'cancelled', note: '合成換成多來源批次' });
  let second = await f.post('billing-documents', { caseId: f.caseItem.id, month: '2026-10', number: 'PART-B2', lineItems: [{ label: '合成第二原額', quantity: 1, unitPriceCents: 201 }] }); second = await f.patch('billing-documents', second, { status: 'issued', sourceReference: '合成第二依據' });
  let batch = await f.post('claim-batches', { month: '2026-10', number: 'PART-MULTI', billingDocumentIds: [f.bill.id, second.id], sourceReference: '合成多來源依據' }); batch = await f.patch('claim-batches', batch, { status: 'verified' });
  const legacy = f.response({ billingDocumentId: second.id, status: 'accepted', amountCents: 201, reason: '' });
  batch = await f.patch('claim-batches', batch, { status: 'reconciling', responseSourceReference: '合成多來源回應', responses: [f.response({}), legacy] });
  const omitted = await f.deny(f.admin, 'PATCH', '/api/claim-batches/' + batch.id, { version: batch.version, responses: [legacy] }, 422); assert.equal(omitted.body.error.code, 'RESPONSE_CHANGE_REASON_REQUIRED');
  batch = await f.patch('claim-batches', batch, { responses: [f.response({})] }); assert.equal(batch.responses.length, 1); // Removing ordinary legacy response retains its pre-existing semantics.
  const facts = structuredClone(batch.responses); batch = await f.patch('claim-batches', batch, { status: 'cancelled', note: '合成取消，保留部分事實' }); assert.deepEqual(batch.responses, facts);
});
test('HTTP missing current parent hides partial current/history/export and cached ACK; original stored snapshots are not repaired', async t => {
  const f = await fixture(t), key = randomUUID(), payload = { version: f.batch.version, status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response({})] }, route = '/api/claim-batches/' + f.batch.id;
  assert.equal((await f.request(f.admin, 'PATCH', route, payload, key)).status, 200);
  // Simulate imported parent withdrawal without defeating the existing FK retention guard.
  const parent = JSON.parse(f.app.db.prepare("SELECT data FROM records WHERE entity='billing-documents' AND id=?").get(f.bill.id).data); parent.caseId = 'synthetic-missing-case'; parent.caseSnapshot.id = parent.caseId;
  f.app.db.prepare("UPDATE records SET data=? WHERE entity='billing-documents' AND id=?").run(JSON.stringify(parent), f.bill.id);
  for (const suffix of ['', '/history', '/export?format=json']) await f.deny(f.admin, 'GET', route + suffix, undefined, 404);
  await f.deny(f.admin, 'PATCH', route, payload, 404, key);
});
for (const phase of ['new', 'cached']) test('real HTTP body in flight ' + phase + ' rejects suspended finance before partial save or cached ACK', async t => {
  const f = await fixture(t), client = f.clients.finance, route = '/api/claim-batches/' + f.batch.id, key = randomUUID(), payload = { version: f.batch.version, status: 'reconciling', responseSourceReference: '合成文件', responses: [f.response({})] }, text = JSON.stringify(payload);
  if (phase === 'cached') assert.equal((await f.request(client, 'PATCH', route, payload, key)).status, 200);
  let pending; const result = new Promise((resolve, reject) => { pending = http.request(f.base + route, { method: 'PATCH', headers: { Origin: f.base, Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.auth.csrfToken, 'Idempotency-Key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => { let bytes = ''; res.setEncoding('utf8'); res.on('data', part => bytes += part); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(bytes) })); }); pending.on('error', reject); pending.write(text.slice(0, -1)); });
  await new Promise(resolve => setTimeout(resolve, 30)); const revoked = await f.request(f.admin, 'PATCH', '/api/account-administration/' + client.auth.user.id, { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成請求中停用' }, randomUUID()); assert.equal(revoked.status, 200, revoked.text);
  const before = snapshot(f.app.db); pending.end(text.slice(-1)); assert.equal((await result).status, 401); assert.deepEqual(snapshot(f.app.db), before);
});
