import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { RULE_PARAMETERS, confirmRule } from '../public/data/business-rule-fields.js';
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, route, data, extra = {}) => {
    const response = await fetch(base + '/api/' + route, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const setup = await request(null, 'POST', 'setup', { name: '合成規則管理員', organizationName: '合成規則機構', email: 'rules@example.test', password: 'synthetic-rules-password' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org: setup.body.organizations[0].id, csrf: setup.body.csrfToken };
  const post = async (entity, data) => { const r = await request(admin, 'POST', entity, data); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; };
  const employee = await post('employees', { name: '合成人員', employeeNo: 'RULE-E' }), clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    await post('users', { name: '合成' + role, email: role + '@rules.example.test', password: 'synthetic-rules-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const r = await request(null, 'POST', 'login', { email: role + '@rules.example.test', password: 'synthetic-rules-password' });
    clients[role] = { cookie: r.headers.get('set-cookie').split(';')[0], org: admin.org, csrf: r.body.csrfToken };
  }
  const payload = (kind = 'pricing', extra = {}) => ({ kind, code: 'SYN-' + kind, name: '合成規則', validFrom: '2026-10-01', validTo: '2026-12-31', sourceReference: '合成核定規格v1', parameters: Object.fromEntries(RULE_PARAMETERS[kind].map(d => [d.key, d.type === 'text' ? 'synthetic-v1' : d.min || 0])), ...extra });
  const counts = () => app.db.prepare('SELECT (SELECT count(*) FROM records) records, (SELECT count(*) FROM record_versions) versions, (SELECT count(*) FROM audit) audit, (SELECT count(*) FROM idempotency) ledger, total_changes() changes').get();
  return { app, request, admin, clients, payload, post, counts };
}
test('six rule kinds persist exact parameters, versions, actor and history', async t => {
  const f = await fixture(t);
  for (const kind of Object.keys(RULE_PARAMETERS)) {
    const data = f.payload(kind), item = await f.post('business-rules', data);
    confirmRule(item, { orgId: f.admin.org, expected: data });
    const r = await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 1, note: '合成第二版' }); assert.equal(r.status, 200);
    const before = f.counts(), h = await f.request(f.admin, 'GET', 'business-rules/' + item.id + '/history?compare=previous');
    assert.equal(h.status, 200); assert.equal(h.body.items.length, 2); assert.equal(h.body.items[0].comparison.previousVersion, 1); assert.equal(h.body.items[0].actor.name, '合成規則管理員'); assert.deepEqual(f.counts(), before);
  }
});
test('rule access is server enforced for all four roles, history, writes and CSRF', async t => {
  const f = await fixture(t), item = await f.post('business-rules', f.payload());
  for (const [role, client] of Object.entries(f.clients)) {
    for (const route of ['business-rules', 'business-rules/' + item.id, 'business-rules/' + item.id + '/history?compare=previous']) {
      const before = f.counts(), r = await f.request(client, 'GET', route); assert.equal(r.status, role === 'caregiver' ? 403 : 200); assert.deepEqual(f.counts(), before);
    }
    if (role !== 'admin') {
      const before = f.counts(); assert.equal((await f.request(client, 'POST', 'business-rules', f.payload('payroll'))).status, 403); assert.equal((await f.request(client, 'PATCH', 'business-rules/' + item.id, { version: 1, status: 'approved' })).status, 403); assert.deepEqual(f.counts(), before);
    }
  }
  const before = f.counts(); assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 1, status: 'approved' }, { 'X-CSRF-Token': '0'.repeat(64) })).status, 403); assert.deepEqual(f.counts(), before);
});
test('invalid parameters, fabricated approval and unknown fields cause no writes', async t => {
  const f = await fixture(t);
  const cases = [{ status: 'approved' }, { sourceReference: 'x'.repeat(2001) }, { validTo: '2026-09-01' }, { validFrom: '0000-01-01' }, { kind: 'constructor' }, { parameters: [] }, { parameters: { unitPriceCents: 1, copayBasisPoints: 10001, monthlyCapCents: 0 } }, { parameters: { unitPriceCents: 0.5, copayBasisPoints: 0, monthlyCapCents: 0 } }, { parameters: { unitPriceCents: 0, copayBasisPoints: 0, monthlyCapCents: 0, hidden: 'secret' } }, { reviewedBy: 'forged' }];
  for (const extra of cases) { const before = f.counts(); const r = await f.request(f.admin, 'POST', 'business-rules', { ...f.payload(), ...extra }); assert.equal(r.status, 422, JSON.stringify(r.body)); assert.deepEqual(f.counts(), before); }
});
test('approval requires source, locks parameters, retains prior version and rejects overlap', async t => {
  const f = await fixture(t), item = await f.post('business-rules', f.payload('pricing', { sourceReference: '' }));
  let before = f.counts(); assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 1, status: 'approved' })).status, 422); assert.deepEqual(f.counts(), before);
  const approved = await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 1, status: 'approved', sourceReference: '合成人工核定依據' }); assert.equal(approved.status, 200); assert.equal(approved.body.item.version, 2);
  before = f.counts(); assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 2, parameters: { unitPriceCents: 5, copayBasisPoints: 0, monthlyCapCents: 0 } })).status, 409); assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 2, status: 'draft' })).status, 409); assert.deepEqual(f.counts(), before);
  const next = await f.post('business-rules', f.payload()); before = f.counts(); const overlap = await f.request(f.admin, 'PATCH', 'business-rules/' + next.id, { version: 1, status: 'approved' }); assert.equal(overlap.status, 409); assert.equal(overlap.body.error.code, 'RULE_PERIOD_CONFLICT'); assert.deepEqual(f.counts(), before);
  const inactive = await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 2, status: 'inactive' }); assert.equal(inactive.status, 200); assert.deepEqual(inactive.body.item.parameters, approved.body.item.parameters);
  assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + next.id, { version: 1, status: 'approved' })).status, 200);
});
test('organization boundaries, CAS conflict and create idempotency preserve data', async t => {
  const f = await fixture(t), key = { 'Idempotency-Key': 'synthetic-rule-repeat' }, data = f.payload();
  const first = await f.request(f.admin, 'POST', 'business-rules', data, key); assert.equal(first.status, 201); const item = first.body.item, before = f.counts();
  const repeat = await f.request(f.admin, 'POST', 'business-rules', data, key); assert.deepEqual(repeat.body, first.body); assert.deepEqual(f.counts(), before);
  assert.equal((await f.request(f.admin, 'PATCH', 'business-rules/' + item.id, { version: 2, note: '錯版' })).status, 409); assert.deepEqual(f.counts(), before);
  const org = await f.request(f.admin, 'POST', 'organizations', { name: '合成第二機構' }), second = { ...f.admin, org: org.body.item.id };
  const list = await f.request(second, 'GET', 'business-rules'); assert.equal(list.body.total, 0);
  const current = f.counts(); for (const route of ['business-rules/' + item.id, 'business-rules/' + item.id + '/history']) assert.equal((await f.request(second, 'GET', route)).status, 404);
  assert.equal((await f.request(second, 'PATCH', 'business-rules/' + item.id, { version: 1, note: '跨機構' })).status, 404); assert.deepEqual(f.counts(), current);
});
test('closed rule query rejects invalid kinds, statuses, duplicates and excessive search', async t => {
  const f = await fixture(t); await f.post('business-rules', f.payload()); await f.post('business-rules', f.payload('payroll'));
  assert.equal((await f.request(f.admin, 'GET', 'business-rules?kind=pricing')).body.total, 1);
  for (const query of ['kind=constructor', 'kind=pricing&kind=payroll', 'status=unknown', 'hidden=x', 'q=' + 'x'.repeat(201)]) { const before = f.counts(); assert.equal((await f.request(f.admin, 'GET', 'business-rules?' + query)).status, 422); assert.deepEqual(f.counts(), before); }
});
