import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { business, replace, decode } from '../src/server/model.mjs';
import { seedDemo } from '../src/server/demo.mjs';
import { CALCULATION_MODE, calculateConfiguredAmount, canonicalCalculationJson } from '../public/data/calculation-core.js';

const path = '/api/calculations/preview', candidatePath = '/api/calculations/candidates', password = 'synthetic-calculation-http-password-only';
function state(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); assert.equal(tables.length, 11);
  return { tables: Object.fromEntries(tables.map(({ name }) => { const s = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); s.setReadBigInts(true); return [name, s.all()]; })),
    schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), changes: db.prepare('SELECT total_changes() changes').get().changes };
}
const unchanged = (db, before) => assert.deepEqual(state(db), before, 'Preview and rejection must change none of the 11 tables, versions, audit, receipts or sessions');
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); assert.notEqual(new URL(base).port, '4310');
  t.after(async () => { const closing = app.close(); app.server.closeAllConnections(); await closing; });
  const request = async (identity, method, route, payload, headers = {}, raw = false) => {
    const response = await fetch(base + route, { method, headers: { Origin: base,
      ...(identity ? { Cookie: identity.cookie, 'X-Org-Id': identity.orgId, 'X-CSRF-Token': identity.csrfToken } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成試算 HTTP 管理者', email: 'calc-http-owner@example.test', password, organizationName: '合成試算 HTTP 機構' });
  assert.equal(setup.status, 201); const owner = { cookie: setup.headers.get('set-cookie').split(';')[0], ...setup.body, orgId: setup.body.organizations[0].id }, clients = { admin: owner };
  const post = async (entity, payload) => { const result = await request(owner, 'POST', '/api/' + entity, payload, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const employee = await post('employees', { name: '合成試算員工', employeeNo: 'CALC-HTTP-E', hourlyRateCents: 123 });
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = 'calc-http-' + role + '@example.test'; await post('users', { name: '合成試算' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], ...login.body, orgId: owner.orgId };
  }
  const parent = await post('cases', { name: '合成試算個案', caseNo: 'CALC-HTTP-C' }), item = await post('service-items', { name: '合成試算服務', code: 'SYN-CALC-HTTP', minutes: 30, unitPriceCents: 7 }),
    services = [{ serviceItemId: item.id, quantity: 3 }], plan = await post('care-plans', { caseId: parent.id, validFrom: '2026-10-01', validTo: '2026-10-31', services, status: 'active' }),
    shift = await post('shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-05', startTime: '09:00', endTime: '10:01', services }),
    submitted = await post('service-records', { shiftId: shift.id, caseId: parent.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:01', services, status: 'submitted', note: '合成原服務\r\n保存原文' });
  const approved = await request(owner, 'POST', '/api/service-records/' + submitted.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成已核閱' }, { 'Idempotency-Key': randomUUID() }); assert.equal(approved.status, 200);
  const source = approved.body.item;
  const rule = async (kind, extra = {}) => {
    const draft = await post('business-rules', { kind, code: 'SYN-CALC-HTTP-' + kind + '-' + randomUUID(), name: '合成假設規則（非正式費率）', validFrom: '2026-10-01', validTo: '2026-10-31',
      sourceReference: '僅合成測試的明確人工參數', parameters: kind === 'pricing' ? { unitPriceCents: 101, copayBasisPoints: 2000, monthlyCapCents: 250 } : { baseCents: 1001, shareBasisPoints: 5000 }, status: 'draft', note: '非政府或薪資規則', ...extra });
    if (extra.status === 'draft') return draft;
    const approved = await request(owner, 'PATCH', '/api/business-rules/' + draft.id, { version: draft.version, status: 'approved' }); assert.equal(approved.status, 200, JSON.stringify(approved.body)); return approved.body.item;
  };
  const pricing = await rule('pricing'), payroll = await rule('payroll'), body = (selected = pricing, policy = { operation: 'quantity-rate', rateParameter: 'unitPriceCents', serviceItemId: item.id }) => ({
    rule: { id: selected.id, version: selected.version }, source: { id: source.id, version: source.version }, policy });
  const arm = change => { let saved; const listener = req => { if (req.url === path && req.method === 'POST') { app.server.off('request', listener); change(req); saved = state(app.db); } };
    app.server.on('request', listener); return () => { assert(saved, 'The real HTTP body await must execute'); unchanged(app.db, saved); }; };
  return { app, owner, clients, request, post, source, item, pricing, payroll, rule, body, arm };
}

test('real HTTP generic candidates return approved same-org rules and source item choices through fixed projections without writes', async t => {
  const f = await fixture(t), draft = await f.rule('pricing', { status: 'draft' }), before = state(f.app.db);
  const result = await f.request(f.clients.finance, 'GET', candidatePath); assert.equal(result.status, 200); assert.equal(result.body.mode, CALCULATION_MODE); assert.equal(result.body.orgId, f.owner.orgId);
  assert.equal(result.body.rules.total, 2); assert.equal(result.body.rules.items.some(r => r.id === draft.id), false); assert.equal(result.body.sources.total, 1);
  for (const rule of result.body.rules.items) {
    assert.equal(rule.orgId, f.owner.orgId); assert.deepEqual(Object.keys(rule).sort(), ['id', 'orgId', 'version', 'kind', 'code', 'name', 'validFrom', 'validTo', 'parameters', 'sourceReference'].sort());
  }
  assert.deepEqual(result.body.sources.items[0].items, [{ serviceItemId: f.item.id, code: f.item.code, name: f.item.name, quantity: 3 }]);
  assert.equal(result.body.sources.items[0].serviceMinutes, 61); assert.equal(JSON.stringify(result.body).includes('password'), false); unchanged(f.app.db, before);
});

test('real HTTP actual demo seed preserves eligible approvals and rejects direct demo previews with existing CSRF and role guards', async t => {
  const f = await fixture(t); assert.equal(seedDemo(f.app.db, { orgId: f.owner.orgId, user: f.owner.user, role: 'admin' }).seeded, true);
  const demo = decode(f.app.db.prepare("SELECT * FROM records WHERE org_id=? AND entity='service-records' AND json_extract(data,'$.billingSnapshot.source')='synthetic-demo'").get(f.owner.orgId)); assert(demo);
  const before = state(f.app.db);
  for (const identity of [f.owner, f.clients.finance]) {
    const candidates = await f.request(identity, 'GET', candidatePath); assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
    assert.equal(candidates.body.sources.total, 1); assert.equal(candidates.body.sources.items[0].id, f.source.id);
    const direct = await f.request(identity, 'POST', path, { ...f.body(f.payroll, { operation: 'flat', amountParameter: 'baseCents' }), source: { id: demo.id, version: demo.version } });
    assert.equal(direct.status, 409); assert.equal(direct.body.error.code, 'CALCULATION_SOURCE_INVALID'); unchanged(f.app.db, before);
  }
  for (const identity of [f.clients.supervisor, f.clients.caregiver, null]) {
    const result = await f.request(identity, 'GET', candidatePath); assert.equal(result.status, identity ? 403 : 401); unchanged(f.app.db, before);
  }
  const csrf = await f.request(f.owner, 'POST', path, { ...f.body(), source: { id: demo.id, version: demo.version } }, { 'X-CSRF-Token': 'synthetic-invalid-token' });
  assert.equal(csrf.status, 403); unchanged(f.app.db, before);
});

test('real HTTP approved explicit pricing and hourly/share previews reproduce canonical SHA and preserve original trial with zero writes', async t => {
  const f = await fixture(t), before = state(f.app.db);
  for (const [identity, rule, policy, expectedCents] of [
    [f.owner, f.pricing, f.body().policy, 303], [f.clients.finance, f.payroll, { operation: 'flat', amountParameter: 'baseCents' }, 1001],
    [f.clients.finance, f.payroll, { operation: 'minutes-hourly', rateParameter: 'baseCents', rounding: 'half-up' }, 1018],
    [f.clients.finance, f.payroll, { operation: 'basis-points', amountParameter: 'baseCents', ratioParameter: 'shareBasisPoints', rounding: 'half-even' }, 500],
  ]) {
    const result = await f.request(identity, 'POST', path, f.body(rule, policy)); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.amountCents, expectedCents); assert.equal(result.body.previewOnly, true);
    const { previewHash, ...response } = result.body, expected = calculateConfiguredAmount({ rule, source: f.source, policy }); assert.deepEqual(response, expected);
    assert.equal(previewHash, createHash('sha256').update(canonicalCalculationJson(expected)).digest('hex'));
    assert.equal(result.body.sourceSnapshot.billingSnapshot.items[0].unitPriceCents, 7); assert.equal(result.body.sourceSnapshot.billingSnapshot.items[0].amountCents, 21);
    assert.equal(result.body.sourceSnapshot.billingSnapshot.employee.hourlyRateCents, 123); assert.equal(result.body.sourceSnapshot.note, '合成原服務\r\n保存原文'); unchanged(f.app.db, before);
  }
});

test('real HTTP explicit hypothetical allocation requires exact copay and basis and never stores consumed quota', async t => {
  const f = await fixture(t), policy = { ...f.body().policy, allocation: { capMeaning: 'eligible-gross-ceiling', consumedCents: 100, capParameter: 'monthlyCapCents', copayBasisPoints: 2000, rounding: 'half-up' } }, before = state(f.app.db);
  const result = await f.request(f.clients.finance, 'POST', path, f.body(f.pricing, policy)); assert.equal(result.status, 200); assert.equal(result.body.allocation.payableCents, 183); assert.equal(result.body.allocation.subsidyCents, 120); unchanged(f.app.db, before);
  for (const [change, status, code] of [[{ copayBasisPoints: 1999 }, 409, 'CALCULATION_COPAY_MISMATCH'], [{ capMeaning: 'official-government-quota' }, 422, 'CALCULATION_ALLOCATION_REQUIRED']]) {
    const result = await f.request(f.clients.finance, 'POST', path, f.body(f.pricing, { ...policy, allocation: { ...policy.allocation, ...change } }));
    assert.equal(result.status, status); assert.equal(result.body.error.code, code); unchanged(f.app.db, before);
  }
});

test('real HTTP generic four-role and anonymous guards precede malformed payloads and keep unauthorized sources private', async t => {
  const f = await fixture(t);
  for (const identity of [f.clients.supervisor, f.clients.caregiver, null]) for (const [method, route, payload] of [['GET', candidatePath], ['POST', path, null]]) {
    const before = state(f.app.db), result = await f.request(identity, method, route, payload); assert.equal(result.status, identity ? 403 : 401); unchanged(f.app.db, before);
  }
  const foreign = await f.post('organizations', { name: '合成第二試算機構' }), before = state(f.app.db), result = await f.request({ ...f.owner, orgId: foreign.id }, 'POST', path, f.body());
  assert.equal(result.status, 404); assert.equal(result.body.error.code, 'NOT_FOUND'); unchanged(f.app.db, before);
});

test('real HTTP generic queries, methods, closed payloads and missing policies reject without writes', async t => {
  const f = await fixture(t);
  for (const [method, route, payload, status] of [
    ['GET', candidatePath + '?q=a&q=b', undefined, 422], ['GET', candidatePath + '?pageSize=101', undefined, 422], ['GET', candidatePath + '?orgId=foreign', undefined, 422],
    ['POST', path + '?source=legacy', f.body(), 422], ['GET', path, undefined, 405], ['POST', candidatePath, {}, 405], ['PATCH', path, f.body(), 405], ['GET', '/api/calculations/unknown', undefined, 404],
    ['POST', path, { ...f.body(), source: { ...f.body().source, orgId: f.owner.orgId } }, 422], ['POST', path, { ...f.body(), historicalTrial: true }, 422],
    ['POST', path, { ...f.body(), policy: {} }, 422], ['POST', path, f.body(f.payroll, { operation: 'minutes-hourly', rateParameter: 'baseCents' }), 422],
  ]) { const before = state(f.app.db), result = await f.request(f.owner, method, route, payload); assert.equal(result.status, status, method + ' ' + route + ' ' + JSON.stringify(result.body)); unchanged(f.app.db, before); }
  const before = state(f.app.db), malformed = await f.request(f.owner, 'POST', path, '{', {}, true); assert.equal(malformed.status, 400); unchanged(f.app.db, before);
});

test('real HTTP inactive rule and stale rule/source versions reject with no legacy snapshot fallback', async t => {
  const f = await fixture(t), before = state(f.app.db);
  for (const key of ['rule', 'source']) {
    const payload = f.body(); payload[key].version++;
    const result = await f.request(f.owner, 'POST', path, payload); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CALCULATION_VERSION_CONFLICT'); unchanged(f.app.db, before);
  }
  const inactive = await f.request(f.owner, 'PATCH', '/api/business-rules/' + f.pricing.id, { version: f.pricing.version, status: 'inactive' }); assert.equal(inactive.status, 200);
  const changed = state(f.app.db), result = await f.request(f.owner, 'POST', path, f.body(inactive.body.item)); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CALCULATION_RULE_NOT_APPROVED'); unchanged(f.app.db, changed);
});

for (const [label, change, code, status] of [
  ['role revocation', f => f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', f.owner.orgId, f.owner.user.id), 'ROLE_FORBIDDEN', 403],
  ['rule version change', f => replace(f.app.db, f.owner.orgId, 'business-rules', f.pricing, { ...business(f.pricing), status: 'inactive' }), 'CALCULATION_VERSION_CONFLICT', 409],
  ['source version change', f => replace(f.app.db, f.owner.orgId, 'service-records', f.source, { ...business(f.source), note: '合成等待期間新版本' }), 'CALCULATION_VERSION_CONFLICT', 409],
]) test('real HTTP generic body await ' + label + ' cannot return a preview based on stale authority or selection', async t => {
  const f = await fixture(t), check = f.arm(() => change(f)), result = await f.request(f.owner, 'POST', path, f.body());
  assert.equal(result.status, status); assert.equal(result.body.error.code, code); check();
});
