import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { business, replace, decode, insert } from '../src/server/model.mjs';
import { canonicalCalculationJson } from '../public/data/calculation-core.js';
import { seedDemo } from '../src/server/demo.mjs';

const root = '/api/employee-payroll', profiles = root + '/profiles', preview = root + '/preview';
const password = 'synthetic-employee-payroll-password-only';
function state(db) { const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); assert.equal(tables.length, 11); return { tables: Object.fromEntries(tables.map(({ name }) => { const s = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); s.setReadBigInts(true); return [name, s.all()]; })), schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), changes: db.prepare('SELECT total_changes() changes').get().changes }; }
const unchanged = (db, before) => assert.deepEqual(state(db), before, 'Rejections and previews preserve all eleven tables, schema and changes');
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); assert.notEqual(new URL(base).port, '4310');
  t.after(async () => { const closing = app.close(); app.server.closeAllConnections(); await closing; });
  const request = async (identity, method, route, payload, headers = {}, raw = false) => {
    const response = await fetch(base + route, { method, headers: { Origin: base, ...(identity ? { Cookie: identity.cookie, 'X-Org-Id': identity.orgId, 'X-CSRF-Token': identity.csrfToken } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成薪資管理者', email: 'payroll-owner@example.test', password, organizationName: '合成薪資機構' }); assert.equal(setup.status, 201);
  const owner = { cookie: setup.headers.get('set-cookie').split(';')[0], ...setup.body, orgId: setup.body.organizations[0].id }, clients = { admin: owner };
  const post = async (entity, payload) => { const result = await request(owner, 'POST', '/api/' + entity, payload, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const employee = await post('employees', { name: '合成薪資員工', employeeNo: 'SYN-PAY-E', hourlyRateCents: 123 });
  const other = await post('employees', { name: '合成其他員工', employeeNo: 'SYN-PAY-E2' });
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const email = 'payroll-' + role + '@example.test'; await post('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], ...login.body, orgId: owner.orgId };
  }
  const parent = await post('cases', { name: '合成薪資個案', caseNo: 'SYN-PAY-C' }), ba = await post('service-items', { name: '合成BA服務', code: 'BA01', minutes: 30, unitPriceCents: 7 }), aa = await post('service-items', { name: '合成AA服務', code: 'AA03', minutes: 30, unitPriceCents: 13 }), services = [{ serviceItemId: ba.id, quantity: 3 }, { serviceItemId: aa.id, quantity: 1 }], plan = await post('care-plans', { caseId: parent.id, validFrom: '2026-09-01', validTo: '2026-11-30', services, status: 'active' });
  const makeSource = async ({ day = '2026-10-05', start = '09:00', end = '10:01', selectedEmployee = employee, endDate } = {}) => {
    const shift = await post('shifts', { caseId: parent.id, employeeId: selectedEmployee.id, carePlanId: plan.id, date: day, startTime: start, endTime: end, services, ...(endDate ? { endDate } : {}) });
    const submitted = await post('service-records', { shiftId: shift.id, caseId: parent.id, employeeId: selectedEmployee.id, date: day, actualStart: start, actualEnd: end, services, status: 'submitted', ...(endDate ? { actualEndDate: endDate } : {}) });
    const result = await request(owner, 'POST', '/api/service-records/' + submitted.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成核閱' }, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  };
  const sources = [await makeSource(), await makeSource({ day: '2026-10-06', start: '09:00', end: '09:01' })];
  const draft = (extra = {}) => ({ employeeId: employee.id, validFrom: '2026-10-01', validTo: '2026-10-31', payrollMode: 'hourly', hourlyRateCents: 101, shareBasisPoints: null, splitBasis: null, aaTreatment: 'not-applicable', rounding: 'half-up', approvalReference: '', note: '合成假設，非正式薪資', status: 'draft', ...extra });
  const create = async (extra = {}) => { const result = await request(owner, 'POST', profiles, draft(extra), { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const update = async (item, extra = {}, key = randomUUID()) => request(owner, 'PATCH', profiles + '/' + item.id, { ...business(item), version: item.version, ...extra }, { 'Idempotency-Key': key });
  const approve = async (item) => { const result = await update(item, { status: 'approved', approvalReference: 'SYNTHETIC-APPROVAL-ONLY' }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const body = (profile, selected = sources, month = '2026-10') => ({ profile: { id: profile.id, version: profile.version }, month, sources: selected.map(source => ({ id: source.id, version: source.version })) });
  const arm = (route, change) => { let saved; const listener = req => { if (req.url === route && ['POST', 'PATCH'].includes(req.method)) { app.server.off('request', listener); change(req); saved = state(app.db); } }; app.server.on('request', listener); return () => { assert(saved); unchanged(app.db, saved); }; };
  return { app, owner, clients, employee, other, ba, aa, sources, makeSource, draft, create, update, approve, body, request, post, arm };
}

test('employee payroll lifecycle requires explicit full configuration, admin approval, immutable history and exact current receipt', async t => {
  const f = await fixture(t), key = randomUUID(), payload = f.draft(); const first = await f.request(f.owner, 'POST', profiles, payload, { 'Idempotency-Key': key }); assert.equal(first.status, 201);
  let before = state(f.app.db), replay = await f.request(f.owner, 'POST', profiles, payload, { 'Idempotency-Key': key }); assert.equal(replay.status, 201); assert.deepEqual(replay.body, first.body); unchanged(f.app.db, before);
  const approved = await f.approve(first.body.item); assert.equal(approved.version, 2); before = state(f.app.db);
  replay = await f.request(f.owner, 'POST', profiles, payload, { 'Idempotency-Key': key }); assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'EMPLOYEE_PAYROLL_RECEIPT_STALE'); unchanged(f.app.db, before);
  const read = await f.request(f.clients.finance, 'GET', profiles + '/' + approved.id); assert.equal(read.status, 200); assert.deepEqual(read.body.item, approved);
  const history = await f.request(f.clients.finance, 'GET', profiles + '/' + approved.id + '/history'); assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => [row.version, row.source, row.snapshot.status]), [[2, 'employee-payroll.approve', 'approved'], [1, 'employee-payroll.create', 'draft']]); unchanged(f.app.db, before);
});

test('employee payroll monthly hourly trial uses per-service exact rounding and frozen sources with zero SQL changes', async t => {
  const f = await fixture(t), profile = await f.approve(await f.create());
  replace(f.app.db, f.owner.orgId, 'service-items', f.ba, { ...business(f.ba), unitPriceCents: 99999 });
  replace(f.app.db, f.owner.orgId, 'employees', f.employee, { ...business(f.employee), hourlyRateCents: 99999 });
  const before = state(f.app.db), result = await f.request(f.clients.finance, 'POST', preview, f.body(profile)); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.totalAmountCents, 105); assert.deepEqual(result.body.lines.map(line => line.amountCents), [103, 2]); assert.deepEqual(result.body.lines.map(line => line.basisCents), [null, null]);
  assert.equal(result.body.sourceSnapshots[0].billingSnapshot.items[0].unitPriceCents, 7); assert.equal(result.body.sourceSnapshots[0].billingSnapshot.employee.hourlyRateCents, 123); assert.equal(result.body.employeeSnapshot.version, 2);
  assert.deepEqual(result.body.lines.map(line => line.trace.numerator), ['6161', '101']); const { previewHash, ...value } = result.body; assert.equal(previewHash, createHash('sha256').update(canonicalCalculationJson(value)).digest('hex')); assert.equal(result.body.previewOnly, true); unchanged(f.app.db, before);
});

test('employee payroll split basis explicitly includes or excludes AA and uses historical code amounts', async t => {
  const f = await fixture(t); let profile = await f.approve(await f.create({ payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 5000, splitBasis: 'approved-service-snapshot', aaTreatment: 'exclude' }));
  let before = state(f.app.db), result = await f.request(f.clients.finance, 'POST', preview, f.body(profile)); assert.equal(result.status, 200); assert.equal(result.body.totalAmountCents, 22); assert.deepEqual(result.body.lines.map(line => line.basisCents), [21, 21]); unchanged(f.app.db, before);
  const stopped = await f.update(profile, { status: 'inactive' }); assert.equal(stopped.status, 200);
  profile = await f.approve(await f.create({ payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 5000, splitBasis: 'approved-service-snapshot', aaTreatment: 'include' }));
  before = state(f.app.db); result = await f.request(f.owner, 'POST', preview, f.body(profile)); assert.equal(result.status, 200); assert.equal(result.body.totalAmountCents, 34); assert.deepEqual(result.body.lines.map(line => line.basisCents), [34, 34]); unchanged(f.app.db, before);
});

test('employee payroll missing real receipt basis is rejected without substitution or saved payout', async t => {
  const f = await fixture(t), profile = await f.approve(await f.create({ payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 6000, splitBasis: 'collected-receipts', aaTreatment: 'include' })), before = state(f.app.db);
  const result = await f.request(f.owner, 'POST', preview, f.body(profile)); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'PAYROLL_BASIS_UNAVAILABLE'); unchanged(f.app.db, before);
});

test('employee payroll four-role and anonymous guards precede malformed payloads and queries', async t => {
  const f = await fixture(t), item = await f.create();
  for (const identity of [f.clients.supervisor, f.clients.caregiver, null]) for (const [method, route, payload] of [['GET', profiles + '?unknown=x'], ['GET', profiles + '/' + item.id], ['GET', profiles + '/' + item.id + '/history'], ['GET', root + '/candidates'], ['POST', preview, {}], ['POST', profiles, {}], ['PATCH', profiles + '/' + item.id, {}]]) { const before = state(f.app.db), result = await f.request(identity, method, route, payload); assert.equal(result.status, identity ? 403 : 401); unchanged(f.app.db, before); }
  for (const [method, route, payload] of [['POST', profiles, {}], ['PATCH', profiles + '/' + item.id, {}]]) { const before = state(f.app.db), result = await f.request(f.clients.finance, method, route, payload); assert.equal(result.status, 403); unchanged(f.app.db, before); }
});

test('employee payroll validates closed fields, no defaults, exact cents, approval reference and mandatory idempotency', async t => {
  const f = await fixture(t);
  for (const payload of [{}, f.draft({ hourlyRateCents: 0 }), f.draft({ hourlyRateCents: 1.5 }), f.draft({ shareBasisPoints: 0 }), f.draft({ rounding: '' }), f.draft({ aaTreatment: 'include' }), f.draft({ employeeId: 'x', extra: true }), f.draft({ status: 'approved', approvalReference: 'SYNTHETIC' }), f.draft({ validTo: '2026-02-30' }), f.draft({ validTo: '2026-09-30' })]) { const before = state(f.app.db), result = await f.request(f.owner, 'POST', profiles, payload, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 422, JSON.stringify(result.body)); unchanged(f.app.db, before); }
  let before = state(f.app.db), result = await f.request(f.owner, 'POST', profiles, f.draft()); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'IDEMPOTENCY_REQUIRED'); unchanged(f.app.db, before);
  const item = await f.create(); before = state(f.app.db); result = await f.update(item, { status: 'approved', approvalReference: '' }); assert.equal(result.status, 422); unchanged(f.app.db, before);
});

test('employee payroll approval overlap, status locking, identity and CAS reject atomically', async t => {
  const f = await fixture(t), approved = await f.approve(await f.create()), second = await f.create({ payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 5000, splitBasis: 'approved-service-snapshot', aaTreatment: 'include' });
  for (const [item, extra, code] of [[second, { status: 'approved', approvalReference: 'SYN-SECOND' }, 'EMPLOYEE_PAYROLL_PERIOD_CONFLICT'], [approved, { status: 'inactive', hourlyRateCents: 102 }, 'EMPLOYEE_PAYROLL_LOCKED'], [second, { employeeId: f.other.id }, 'EMPLOYEE_PAYROLL_IDENTITY_IMMUTABLE'], [second, { version: 0 }, 'EMPLOYEE_PAYROLL_INVALID'], [second, { version: second.version + 1 }, 'VERSION_CONFLICT']]) { const before = state(f.app.db), result = await f.update(item, extra); assert.equal(result.status, code === 'EMPLOYEE_PAYROLL_INVALID' ? 422 : 409); assert.equal(result.body.error.code, code); unchanged(f.app.db, before); }
  const stopped = await f.update(approved, { status: 'inactive' }); assert.equal(stopped.status, 200); const before = state(f.app.db), replay = await f.update(stopped.body.item, { status: 'approved' }); assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'EMPLOYEE_PAYROLL_LOCKED'); unchanged(f.app.db, before);
  assert.equal((await f.approve(second)).status, 'approved');
});

test('employee payroll candidate filters are strict, paged and exclude verified synthetic demonstration approvals', async t => {
  const f = await fixture(t); seedDemo(f.app.db, { orgId: f.owner.orgId, user: f.owner.user, role: 'admin' });
  let before = state(f.app.db), result = await f.request(f.clients.finance, 'GET', root + '/candidates?employeeId=' + f.employee.id + '&month=2026-10&page=2&pageSize=1'); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.total, 2); assert.equal(result.body.items.length, 1); assert.equal(result.body.items[0].employeeId, f.employee.id); unchanged(f.app.db, before);
  for (const query of ['employeeId=' + f.employee.id, 'employeeId=' + f.employee.id + '&month=2026-10&month=2026-10', 'employeeId=' + f.employee.id + '&month=2026-10%0A', 'employeeId=' + f.employee.id + '&month=2026-10&page=1%0A', 'employeeId=' + f.employee.id + '&month=2026-10&pageSize=101', 'employeeId=' + f.employee.id + '&month=2026-10&orgId=foreign']) { before = state(f.app.db); result = await f.request(f.owner, 'GET', root + '/candidates?' + query); assert.equal(result.status, 422, query); unchanged(f.app.db, before); }
});

test('employee payroll verified demonstration exclusion still requires intact case, employee and completed shift parents', async t => {
  for (const parentKind of ['case', 'shift', 'employee']) {
    const f = await fixture(t); seedDemo(f.app.db, { orgId: f.owner.orgId, user: f.owner.user, role: 'admin' });
    const demo = decode(f.app.db.prepare("SELECT * FROM records WHERE org_id=? AND entity='service-records' AND json_extract(data,'$.billingSnapshot.source')='synthetic-demo' LIMIT 1").get(f.owner.orgId)); assert(demo);
    if (parentKind === 'case') { const missing = { ...business(demo), caseId: randomUUID() }; replace(f.app.db, f.owner.orgId, 'service-records', demo, missing); }
    if (parentKind === 'shift') { const shift = decode(f.app.db.prepare("SELECT * FROM records WHERE id=? AND entity='shifts'").get(demo.shiftId)); replace(f.app.db, f.owner.orgId, 'shifts', shift, { ...business(shift), status: 'cancelled' }); }
    if (parentKind === 'employee') { const missing = { ...business(demo), employeeId: randomUUID(), billingSnapshot: { ...demo.billingSnapshot, employee: { ...demo.billingSnapshot.employee, id: randomUUID() } } }; missing.billingSnapshot.employee.id = missing.employeeId; replace(f.app.db, f.owner.orgId, 'service-records', demo, missing); }
    const employeeId = parentKind === 'employee' ? f.employee.id : demo.employeeId, month = demo.date.slice(0, 7), before = state(f.app.db);
    // Generic canonical candidates prove every demo's parents; payroll candidates prove a selected demo's parents.
    const result = await f.request(f.owner, 'GET', parentKind === 'employee' ? '/api/calculations/candidates' : root + '/candidates?employeeId=' + employeeId + '&month=' + month);
    assert.equal(result.status, 409, parentKind + ' ' + JSON.stringify(result.body)); assert.equal(result.body.error.code, 'CALCULATION_STORED_INVALID'); unchanged(f.app.db, before);
  }
});

test('employee payroll paged profile lists expose only this page authorized employee names and current identifiers', async t => {
  const f = await fixture(t); await f.create(); await f.create({ employeeId: f.other.id }); const before = state(f.app.db);
  const result = await f.request(f.clients.finance, 'GET', profiles + '?pageSize=1'); assert.equal(result.status, 200); assert.equal(result.body.total, 2); assert.equal(result.body.items.length, 1); assert.equal(result.body.employeeSnapshots.length, 1);
  const name = result.body.items[0].employeeId === f.employee.id ? f.employee : f.other; assert.deepEqual(result.body.employeeSnapshots[0], { id: name.id, name: name.name, employeeNo: name.employeeNo, version: name.version }); unchanged(f.app.db, before);
  for (const query of [f.other.name, f.other.employeeNo.toLowerCase()]) { const searched = await f.request(f.clients.finance, 'GET', profiles + '?q=' + encodeURIComponent(query)); assert.equal(searched.status, 200); assert.equal(searched.body.total, 1); assert.equal(searched.body.items[0].employeeId, f.other.id); assert.deepEqual(searched.body.employeeSnapshots, [{ id: f.other.id, name: f.other.name, employeeNo: f.other.employeeNo, version: f.other.version }]); unchanged(f.app.db, before); }
  const none = await f.request(f.clients.finance, 'GET', profiles + '?q=' + encodeURIComponent('不存在的合成人員')); assert.equal(none.status, 200); assert.equal(none.body.total, 0); assert.deepEqual(none.body.employeeSnapshots, []); unchanged(f.app.db, before);
});

test('employee payroll forged history sources and SQL text types fail closed even with matching current JSON', async t => {
  for (const wrong of ['source', 'time-blob', 'snapshot-blob']) {
    const f = await fixture(t); const id = randomUUID(), time = new Date().toISOString(), payload = f.draft(), snapshot = { ...payload, id, orgId: f.owner.orgId, version: 1, createdAt: time, updatedAt: time };
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, f.owner.orgId, 'employee-payroll-profiles', JSON.stringify(payload), 1, time, time);
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.owner.orgId, 'employee-payroll-profiles', id, 1, wrong === 'snapshot-blob' ? Buffer.from(JSON.stringify(snapshot)) : JSON.stringify(snapshot), wrong === 'time-blob' ? Buffer.from(time) : time, wrong === 'source' ? 'employee-payroll.approve' : 'employee-payroll.create');
    const before = state(f.app.db); for (const route of [profiles, profiles + '/' + id, profiles + '/' + id + '/history']) { const result = await f.request(f.owner, 'GET', route); assert.equal(result.status, 409, wrong); assert.equal(result.body.error.code, 'EMPLOYEE_PAYROLL_STORED_INVALID'); unchanged(f.app.db, before); }
  }
});

test('employee payroll pending or synthetic sources cannot enter monthly previews and source hash remains fixed', async t => {
  const f = await fixture(t), profile = await f.approve(await f.create()); seedDemo(f.app.db, { orgId: f.owner.orgId, user: f.owner.user, role: 'admin' });
  const demo = decode(f.app.db.prepare("SELECT * FROM records WHERE org_id=? AND entity='service-records' AND json_extract(data,'$.billingSnapshot.source')='synthetic-demo' LIMIT 1").get(f.owner.orgId));
  const pending = insert(f.app.db, f.owner.orgId, 'service-records', { ...business(f.sources[0]), status: 'submitted' });
  const before = state(f.app.db);
  for (const selected of [demo, pending]) { const result = await f.request(f.owner, 'POST', preview, f.body(profile, [selected], selected.date.slice(0, 7))); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CALCULATION_SOURCE_INVALID'); unchanged(f.app.db, before); }
});

test('employee payroll selected sources require exact versions, same employee/month, full date coverage and current approval', async t => {
  const f = await fixture(t), draft = await f.create(), profile = await f.approve(draft), otherSource = await f.makeSource({ day: '2026-10-07', selectedEmployee: f.other }), november = await f.makeSource({ day: '2026-11-01' });
  for (const [payload, code] of [[{ ...f.body(profile), profile: { id: profile.id, version: profile.version + 1 } }, 'VERSION_CONFLICT'], [f.body(profile, [{ ...f.sources[0], version: f.sources[0].version + 1 }]), 'CALCULATION_VERSION_CONFLICT'], [f.body(profile, [otherSource]), 'EMPLOYEE_PAYROLL_SOURCE_MISMATCH'], [f.body(profile, [november]), 'EMPLOYEE_PAYROLL_SOURCE_MISMATCH'], [f.body(profile, [november], '2026-11'), 'EMPLOYEE_PAYROLL_DATE_MISMATCH']]) { const before = state(f.app.db), result = await f.request(f.owner, 'POST', preview, payload); assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.error.code, code); unchanged(f.app.db, before); }
  const stopped = await f.update(profile, { status: 'inactive' }); assert.equal(stopped.status, 200); const before = state(f.app.db), result = await f.request(f.owner, 'POST', preview, f.body(stopped.body.item)); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'EMPLOYEE_PAYROLL_NOT_APPROVED'); unchanged(f.app.db, before);
});

test('employee payroll overnight source uses start-month attribution and all occupied days for effective coverage', async t => {
  const f = await fixture(t), overnight = await f.makeSource({ day: '2026-10-31', start: '23:30', end: '00:30', endDate: '2026-11-01' });
  let profile = await f.approve(await f.create()), before = state(f.app.db), result = await f.request(f.owner, 'POST', preview, f.body(profile, [overnight])); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'EMPLOYEE_PAYROLL_DATE_MISMATCH'); unchanged(f.app.db, before);
  assert.equal((await f.update(profile, { status: 'inactive' })).status, 200); profile = await f.approve(await f.create({ validTo: '2026-11-01' })); before = state(f.app.db); result = await f.request(f.clients.finance, 'POST', preview, f.body(profile, [overnight])); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.month, '2026-10'); assert.equal(result.body.lines[0].serviceMinutes, 60); assert.equal(result.body.totalAmountCents, 101); unchanged(f.app.db, before);
});

test('employee payroll unknown snapshot service codes fail closed rather than silently dropping revenue', async t => {
  const f = await fixture(t), item = await f.post('service-items', { name: '合成未核定服務', code: 'BA99', minutes: 30, unitPriceCents: 20 });
  // Build a genuine reviewed service using the unknown code; classification is separately unapproved.
  const parent = await f.post('cases', { name: '合成未知碼個案', caseNo: 'SYN-UNKNOWN-C' }), services = [{ serviceItemId: item.id, quantity: 1 }], plan = await f.post('care-plans', { caseId: parent.id, validFrom: '2026-10-01', validTo: '2026-10-31', services, status: 'active' }), shift = await f.post('shifts', { caseId: parent.id, employeeId: f.employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services }), draft = await f.post('service-records', { shiftId: shift.id, caseId: parent.id, employeeId: f.employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services, status: 'submitted' });
  const source = await f.request(f.owner, 'POST', '/api/service-records/' + draft.id + '/review', { version: draft.version, decision: 'approved', reviewNote: '合成' }, { 'Idempotency-Key': randomUUID() }); assert.equal(source.status, 200);
  const profile = await f.approve(await f.create({ payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 5000, splitBasis: 'approved-service-snapshot', aaTreatment: 'exclude' })), before = state(f.app.db), result = await f.request(f.owner, 'POST', preview, f.body(profile, [source.body.item])); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'EMPLOYEE_PAYROLL_BASIS_CODE_UNSUPPORTED'); unchanged(f.app.db, before);
});

test('employee payroll malformed, duplicate, empty and oversized selections plus wrong query/method reject without writes', async t => {
  const f = await fixture(t), profile = await f.approve(await f.create());
  for (const payload of [{}, { ...f.body(profile), amountCents: 1 }, { ...f.body(profile), month: '2026-10\n' }, { ...f.body(profile), sources: [] }, f.body(profile, [f.sources[0], f.sources[0]]), { ...f.body(profile), sources: Array.from({ length: 101 }, () => ({ id: randomUUID(), version: 1 })) }, { ...f.body(profile), profile: { ...f.body(profile).profile, employeeId: f.employee.id } }]) { const before = state(f.app.db), result = await f.request(f.owner, 'POST', preview, payload); assert.equal(result.status, 422, JSON.stringify(result.body)); unchanged(f.app.db, before); }
  for (const [method, path, payload, status] of [['POST', preview + '?month=2026-10', f.body(profile), 422], ['GET', preview, undefined, 405], ['POST', root + '/candidates', {}, 405], ['DELETE', profiles + '/' + profile.id, undefined, 405], ['GET', profiles + '?unknown=1', undefined, 422], ['POST', profiles + '/' + profile.id + '/history', {}, 405], ['GET', root + '/unknown', undefined, 404]]) { const before = state(f.app.db), result = await f.request(f.owner, method, path, payload); assert.equal(result.status, status, method + path); unchanged(f.app.db, before); }
});

test('employee payroll fresh HTTP authority rejects revocation during body read for both writes and trial', async t => {
  for (const mutation of [false, true]) { const f = await fixture(t), profile = await f.approve(await f.create()), path = mutation ? profiles : preview, confirm = f.arm(path, () => f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', f.owner.orgId, f.owner.user.id));
    const result = await f.request(f.owner, 'POST', path, mutation ? f.draft() : f.body(profile), { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 403); confirm(); }
});

test('employee payroll rejects inactive employee, foreign source/profile and invalid current raw head without writes', async t => {
  const f = await fixture(t), item = await f.approve(await f.create()); replace(f.app.db, f.owner.orgId, 'employees', f.employee, { ...business(f.employee), status: 'inactive' });
  for (const [path, payload] of [[preview, f.body(item)], [profiles, f.draft()]]) { const before = state(f.app.db), result = await f.request(f.owner, 'POST', path, payload, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'EMPLOYEE_PAYROLL_EMPLOYEE_INACTIVE'); unchanged(f.app.db, before); }
  const foreign = await f.post('organizations', { name: '合成第二薪資機構' }), before = state(f.app.db), result = await f.request({ ...f.owner, orgId: foreign.id }, 'GET', profiles + '/' + item.id); assert.equal(result.status, 404); unchanged(f.app.db, before);
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), hourlyRateCents: 999 }), item.id); const corrupted = state(f.app.db), read = await f.request(f.owner, 'GET', profiles); assert.equal(read.status, 409); assert.equal(read.body.error.code, 'EMPLOYEE_PAYROLL_STORED_INVALID'); unchanged(f.app.db, corrupted);
});

test('employee payroll history is atomic with state, audit and idempotency on injected audit failure', async t => {
  const f = await fixture(t); f.app.db.exec("CREATE TRIGGER reject_payroll_audit BEFORE INSERT ON audit WHEN NEW.action LIKE 'employee-payroll.%' BEGIN SELECT RAISE(ABORT,'synthetic payroll audit failure'); END;"); const before = state(f.app.db);
  const result = await f.request(f.owner, 'POST', profiles, f.draft(), { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 500);
  const after = state(f.app.db); assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.schema, before.schema); assert.equal(after.changes, before.changes + 2, 'SQLite counts the attempted record/version writes even though the whole transaction rolled back');
});
