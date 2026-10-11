import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { business, replace } from '../src/server/model.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { LTC_BA_AA_CATALOG } from '../public/data/ltc-ba-aa-catalog.js';
import { LTC_CATALOG_VERSION, LTC_CODE_CALCULATION_MODE, calculateLtcCodeAmount } from '../public/data/ltc-code-calculation.js';
import { canonicalCalculationJson } from '../public/data/calculation-core.js';

const catalogPath = '/api/ltc-codes/catalog', previewPath = '/api/ltc-codes/preview';
const password = 'synthetic-ltc-http-password-only';
function state(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(tables.length, 11);
  return { tables: Object.fromEntries(tables.map(({ name }) => { const statement = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })),
    schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), changes: db.prepare('SELECT total_changes() changes').get().changes };
}
const unchanged = (db, before) => assert.deepEqual(state(db), before, 'Preview or rejection must leave every table, history, audit, session, receipt and total_changes unchanged');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 }), base = await app.listen();
  assert.notEqual(new URL(base).port, '4310');
  t.after(async () => { const closing = app.close(); app.server.closeAllConnections(); await closing; });
  const request = async (identity, method, path, payload, headers = {}, raw = false) => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Origin: base,
      ...(identity ? { Cookie: identity.cookie, 'X-Org-Id': identity.orgId, 'X-CSRF-Token': identity.csrfToken } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const content = await response.text(); let body; try { body = JSON.parse(content); } catch { body = content; }
    return { status: response.status, body, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成官方碼 HTTP 管理者', email: 'ltc-http-owner@example.test', password, organizationName: '合成官方碼 HTTP 機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const owner = { cookie: setup.headers.get('set-cookie').split(';')[0], ...setup.body, orgId: setup.body.organizations[0].id }, clients = { admin: owner };
  const post = async (entity, payload, identity = owner) => {
    const result = await request(identity, 'POST', '/api/' + entity, payload, { 'Idempotency-Key': randomUUID() });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  };
  const employee = await post('employees', { name: '合成官方碼原核閱員工', employeeNo: 'SYN-LTC-HTTP-E', hourlyRateCents: 11 }),
    parent = await post('cases', { name: '合成官方碼原核閱個案', caseNo: 'SYN-LTC-HTTP-C' });
  const login = async email => {
    const result = await request(null, 'POST', '/api/login', { email, password }); assert.equal(result.status, 200, JSON.stringify(result.body));
    return { cookie: result.headers.get('set-cookie').split(';')[0], ...result.body, orgId: owner.orgId };
  };
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = 'ltc-http-' + role + '@example.test';
    await post('users', { name: '合成官方碼' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }); clients[role] = await login(email);
  }
  let sequence = 0;
  const source = async (code = 'BA15', quantity = 3, options = {}) => {
    const d = new Date('2026-10-05T00:00:00Z'); d.setUTCDate(d.getUTCDate() + sequence++);
    const date = options.date || d.toISOString().slice(0, 10), start = options.start || '09:00', end = options.end || '10:30';
    const item = await post('service-items', { code, name: '合成保存原項目 ' + code + ' ' + sequence, minutes: 30, unitPriceCents: 7 });
    const extraItems = [];
    for (const extra of options.extraCodes || []) extraItems.push(await post('service-items', { code: extra.code, name: '合成額外項目 ' + sequence + ' ' + extra.code, minutes: 30, unitPriceCents: 7 }));
    const services = [{ serviceItemId: item.id, quantity }, ...extraItems.map((extra, i) => ({ serviceItemId: extra.id, quantity: options.extraCodes[i].quantity || 1 }))];
    const plan = await post('care-plans', { caseId: parent.id, validFrom: date, validTo: options.endDate || date, services: services.map(s => ({ ...s, quantity: 100 })), status: 'active' });
    const shift = await post('shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: plan.id, date, startTime: start, endTime: end, services,
      ...(options.endDate ? { endDate: options.endDate } : {}) });
    const submitted = await post('service-records', { shiftId: shift.id, caseId: parent.id, employeeId: employee.id, date, actualStart: start, actualEnd: end,
      ...(options.endDate ? { actualEndDate: options.endDate } : {}), services, status: 'submitted', note: '合成原保存\r\n文字' });
    const reviewed = await request(owner, 'POST', '/api/service-records/' + submitted.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成官方碼核閱' }, { 'Idempotency-Key': randomUUID() });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body)); return { record: reviewed.body.item, item };
  };
  const first = await source(), body = (selected = first, extra = {}) => ({ catalogVersion: LTC_CATALOG_VERSION, source: { id: selected.record.id, version: selected.record.version },
    policy: { operation: 'official-code-quantity', serviceItemId: selected.item.id, code: selected.item.code, region: 'ordinary', paymentContext: 'standard', rounding: 'half-up',
      eligibility: { confirmed: true, sourceReference: '合成人工資格依據，非正式核定' }, ...extra } });
  const arm = (change, path = previewPath) => {
    let before; const listener = req => { if (req.url === path && req.method === 'POST') { app.server.off('request', listener); change(req); before = state(app.db); } };
    app.server.on('request', listener); return () => { assert(before, 'The real HTTP body await window must execute'); unchanged(app.db, before); };
  };
  return { app, base, request, owner, clients, post, parent, employee, source, first, body, arm, login };
}

test('real HTTP catalog exposes exactly all 39 pinned prices and full conditions to current same-org admin/finance, with no writes', async t => {
  const f = await fixture(t), { items, ...metadata } = LTC_BA_AA_CATALOG;
  for (const identity of [f.owner, f.clients.finance]) {
    const before = state(f.app.db), result = await f.request(identity, 'GET', catalogPath + '?pageSize=100');
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body, { mode: LTC_CODE_CALCULATION_MODE, orgId: f.owner.orgId, catalog: metadata, items, total: 39, page: 1, pageSize: 100 });
    assert.equal(JSON.stringify(result.body).includes(f.owner.user.id), false); assert.equal(JSON.stringify(result.body).includes('password'), false); unchanged(f.app.db, before);
  }
  const before = state(f.app.db), aa = await f.request(f.owner, 'GET', catalogPath + '?category=AA'), ba = await f.request(f.owner, 'GET', catalogPath + '?category=BA&pageSize=100'),
    search = await f.request(f.owner, 'GET', catalogPath + '?' + new URLSearchParams({ q: 'BA09a' })), candidates = await f.request(f.owner, 'GET', '/api/calculations/candidates');
  assert.equal(aa.body.total, 12); assert.equal(ba.body.total, 27); assert.equal(search.body.total, 1); assert.equal(search.body.items[0].ordinaryCents, 250000);
  assert.equal(candidates.status, 200); assert.equal(candidates.body.orgId, f.owner.orgId); assert.equal(candidates.body.sources.items[0].orgId, f.owner.orgId);
  assert.deepEqual(candidates.body.sources.items[0].items, [{ serviceItemId: f.first.item.id, code: 'BA15', name: f.first.item.name, quantity: 3 }]); unchanged(f.app.db, before);
});

test('real HTTP source quantities choose fixed official prices, region and explicit 50 percent while original billing snapshot stays untouched', async t => {
  const f = await fixture(t), before = state(f.app.db);
  for (const [extra, gross, payment, family] of [[{}, 58500, 58500, 0], [{ region: 'indigenous-or-island' }, 70500, 70500, 0], [{ paymentContext: 'shared-family-50-percent' }, 58500, 29250, 29250]]) {
    const payload = f.body(f.first, extra), result = await f.request(f.clients.finance, 'POST', previewPath, payload);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.previewOnly, true);
    assert.deepEqual([result.body.catalogGrossCents, result.body.eligiblePaymentBaseCents, result.body.sharedFamilySelfPayCents], [gross, payment, family]);
    assert.equal(result.body.sourceSnapshot.billingSnapshot.items[0].amountCents, 21); assert.equal(result.body.sourceSnapshot.note, '合成原保存\r\n文字');
    assert.equal(result.body.copayCents, null); assert.equal(result.body.capUsageCents, null); assert.equal(result.body.crossRecordLimitsVerification, 'not-verified');
    const { previewHash, ...response } = result.body, expected = calculateLtcCodeAmount({ catalogVersion: payload.catalogVersion, source: f.first.record, policy: payload.policy });
    assert.deepEqual(response, expected); assert.equal(previewHash, createHash('sha256').update(canonicalCalculationJson(expected)).digest('hex'));
    unchanged(f.app.db, before);
  }
});

test('real HTTP all four roles and anonymous calls enforce catalog and preview authorization before reading request fields', async t => {
  const f = await fixture(t);
  for (const role of ['supervisor', 'caregiver']) for (const [method, path, payload] of [['GET', catalogPath], ['POST', previewPath, null]]) {
    const before = state(f.app.db), result = await f.request(f.clients[role], method, path, payload); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN'); unchanged(f.app.db, before);
  }
  for (const [method, path, payload] of [['GET', catalogPath], ['POST', previewPath, f.body()]]) {
    const before = state(f.app.db), result = await f.request(null, method, path, payload); assert.equal(result.status, 401); unchanged(f.app.db, before);
  }
});

test('real HTTP unobservable cross-org source IDs reject even when the same admin has another organization', async t => {
  const f = await fixture(t), foreign = await f.post('organizations', { name: '合成第二官方碼機構' }), otherIdentity = { ...f.owner, orgId: foreign.id };
  const before = state(f.app.db), result = await f.request(otherIdentity, 'POST', previewPath, f.body());
  assert.equal(result.status, 404); assert.equal(result.body.error.code, 'NOT_FOUND'); unchanged(f.app.db, before);
  const denied = await f.request({ ...f.clients.finance, orgId: foreign.id }, 'GET', catalogPath); assert.equal(denied.status, 403); unchanged(f.app.db, before);
});

test('real HTTP fixed catalog version, current source version and source approval cannot silently fall back', async t => {
  const f = await fixture(t);
  for (const [payload, code] of [[{ ...f.body(), catalogVersion: 'old-2017' }, 'LTC_CATALOG_VERSION_CONFLICT'], [{ ...f.body(), source: { ...f.body().source, version: f.first.record.version + 1 } }, 'CALCULATION_VERSION_CONFLICT']]) {
    const before = state(f.app.db), result = await f.request(f.owner, 'POST', previewPath, payload); assert.equal(result.status, 409); assert.equal(result.body.error.code, code); unchanged(f.app.db, before);
  }
  replace(f.app.db, f.owner.orgId, 'service-records', f.first.record, { ...business(f.first.record), status: 'returned' });
  const before = state(f.app.db), result = await f.request(f.owner, 'POST', previewPath, { ...f.body(), source: { id: f.first.record.id, version: f.first.record.version + 1 } });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CALCULATION_SOURCE_INVALID'); unchanged(f.app.db, before);
});

test('real HTTP queries, methods and unknown paths are closed with zero writes', async t => {
  const f = await fixture(t);
  for (const [method, path, payload, status] of [
    ['GET', catalogPath + '?page=01', undefined, 422], ['GET', catalogPath + '?category=BA&category=AA', undefined, 422], ['GET', catalogPath + '?pageSize=101', undefined, 422],
    ['GET', catalogPath + '?manualRate=1', undefined, 422], ['POST', previewPath + '?orgId=other', f.body(), 422], ['POST', catalogPath, {}, 405],
    ['GET', previewPath, undefined, 405], ['HEAD', previewPath, undefined, 405], ['PATCH', previewPath, f.body(), 405], ['DELETE', catalogPath, undefined, 405],
    ['GET', '/api/ltc-codes/unknown', undefined, 404],
  ]) {
    const before = state(f.app.db), result = await f.request(f.owner, method, path, payload); assert.equal(result.status, status, method + ' ' + path); unchanged(f.app.db, before);
  }
});

test('real HTTP CSRF, origin, content type, malformed and enlarged payloads reject before all writes', async t => {
  const f = await fixture(t);
  for (const [payload, headers, raw, status] of [
    [f.body(), { 'X-CSRF-Token': '0'.repeat(64) }, false, 403], [f.body(), { Origin: 'https://untrusted.example.test' }, false, 403],
    [f.body(), { 'Content-Type': 'text/plain' }, false, 415], ['{', {}, true, 400], ['null', {}, true, 400], ['[]', {}, true, 400],
    [{ ...f.body(), password: 'synthetic-unexpected-field' }, {}, false, 422], [{ ...f.body(), source: { ...f.body().source, orgId: f.owner.orgId } }, {}, false, 422],
    [f.body(f.first, { quantity: 1 }), {}, false, 422], [f.body(f.first, { eligibility: { confirmed: false, sourceReference: '合成' } }), {}, false, 422],
    ['{"padding":"' + 'x'.repeat(1024 * 1024) + '"}', {}, true, 413],
  ]) {
    const before = state(f.app.db), result = await f.request(f.owner, 'POST', previewPath, payload, headers, raw); assert.equal(result.status, status); unchanged(f.app.db, before);
  }
});

test('real HTTP explicit original code prevents auto-added AA and rejects illegal same-source quantities and combinations', async t => {
  const f = await fixture(t), bad = await f.source('BA01', 3), conflict = await f.source('BA07', 1, { extraCodes: [{ code: 'BA23', quantity: 1 }] }),
    aa = await f.source('AA08', 1, { start: '09:00', end: '10:30' });
  for (const [payload, code] of [[f.body(f.first, { code: 'AA08' }), 'LTC_SOURCE_CODE_MISMATCH'], [f.body(bad), 'LTC_SOURCE_CONDITION_CONFLICT'],
    [f.body(conflict), 'LTC_SOURCE_CONDITION_CONFLICT'], [f.body(aa), 'LTC_SOURCE_CONDITION_CONFLICT']]) {
    const before = state(f.app.db), result = await f.request(f.owner, 'POST', previewPath, payload); assert.equal(result.status, 409); assert.equal(result.body.error.code, code); unchanged(f.app.db, before);
  }
});

for (const [label, change, status, code] of [
  ['role revoked', f => f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', f.owner.orgId, f.owner.user.id), 403, 'ROLE_FORBIDDEN'],
  ['membership removed', f => f.app.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.owner.orgId, f.owner.user.id), 403, 'ORG_FORBIDDEN'],
  ['session deleted', f => f.app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.owner.user.id), 401, 'AUTH_REQUIRED'],
  ['session expired', f => f.app.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(f.owner.user.id), 401, 'AUTH_REQUIRED'],
  ['CSRF changed', f => f.app.db.prepare('UPDATE sessions SET csrf=? WHERE user_id=?').run('0'.repeat(64), f.owner.user.id), 403, 'CSRF_INVALID'],
  ['source version changed', f => replace(f.app.db, f.owner.orgId, 'service-records', f.first.record, { ...business(f.first.record), note: '合成等待期間新版' }), 409, 'CALCULATION_VERSION_CONFLICT'],
  ['origin changed', (_f, req) => { req.headers.origin = 'https://untrusted.example.test'; }, 403, 'ORIGIN_FORBIDDEN'],
]) test('real HTTP body await ' + label + ' rejects late preview under current authority with zero subsequent writes', async t => {
  const f = await fixture(t), check = f.arm(req => change(f, req)), result = await f.request(f.owner, 'POST', previewPath, f.body());
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.error.code, code); check();
});

test('real HTTP body await cannot swap to another org or another session of the same currently authorized user', async t => {
  for (const option of ['org', 'session']) {
    const f = await fixture(t), foreign = option === 'org' ? await f.post('organizations', { name: '合成等待期間第二機構' }) : null;
    const check = f.arm(req => {
      if (option === 'org') req.headers['x-org-id'] = foreign.id;
      else { const token = 'a'.repeat(64); f.app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), f.owner.user.id, f.owner.csrfToken, Date.now() + 60000); req.headers.cookie = 'suiyue_session=' + token; }
    }), result = await f.request(f.owner, 'POST', previewPath, f.body());
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN'); check();
  }
});

test('real HTTP retained finance membership suspension during body read cannot return private preview or restore old sessions', async t => {
  const f = await fixture(t), target = f.clients.finance.user.id, check = f.arm(() => {
    f.app.db.exec('BEGIN IMMEDIATE'); try { commitAccountChange(f.app.db, { orgId: f.owner.orgId, role: 'admin', user: f.owner.user }, target,
      { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成等待期間停用' }); f.app.db.exec('COMMIT'); }
    catch (error) { f.app.db.exec('ROLLBACK'); throw error; }
    assert.equal(f.app.db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(f.owner.orgId, target).role, 'finance');
  }), result = await f.request(f.clients.finance, 'POST', previewPath, f.body());
  assert.equal(result.status, 401); assert.equal(result.body.error.code, 'AUTH_REQUIRED'); check();
});

test('real HTTP current service catalog prices cannot replace the original approved snapshot or official fixed rate', async t => {
  const f = await fixture(t), current = await f.request(f.owner, 'PATCH', '/api/service-items/' + f.first.item.id, { version: f.first.item.version, unitPriceCents: 999999 });
  assert.equal(current.status, 200, JSON.stringify(current.body)); const before = state(f.app.db), result = await f.request(f.owner, 'POST', previewPath, f.body());
  assert.equal(result.status, 200); assert.equal(result.body.unitPriceCents, 19500); assert.equal(result.body.sourceSnapshot.billingSnapshot.items[0].unitPriceCents, 7); unchanged(f.app.db, before);
});
