import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createServiceItemEditor } from '../public/data/service-item-editor.js';

const ENTITY = 'service-items', password = 'synthetic-service-editor-password';
const keys = ['code', 'name', 'minutes', 'unitPriceCents', 'validFrom', 'validTo', 'status', 'note'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const route = item => `/api/${ENTITY}/${item.id}`;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const editorFor = existing => createServiceItemEditor({ existing });
const values = (e, changes = {}) => ({ ...e.initial, ...changes });
const projection = item => Object.fromEntries(keys.filter(k => Object.hasOwn(item, k)).map(k => [k, item[k]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  async function request(client, method, url, data, headers = {}) {
    const r = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await r.arrayBuffer()), text = bytes.toString('utf8');
    return { status: r.status, headers: r.headers, bytes, body: r.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成服務管理者', email: 'admin@service-editor.example.test', password, organizationName: '合成服務甲機構' }); assert.equal(setup.status, 201);
  const clientFrom = r => ({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrfToken, org: setup.body.organizations[0].id, user: r.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers = {}) { const r = await request(caller, 'POST', '/api/' + entity, data, headers); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; }
  async function patch(entity, item, data, caller = admin) { const r = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { ...data, version: item.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.item; }
  const employee = await create('employees', { employeeNo: 'TEST-SIE-EMP', name: '合成服務居服員', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@service-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const data = extra => ({ code: 'TEST-' + id(), name: '合成測試服務', minutes: 30, unitPriceCents: 12345, validFrom: '', validTo: '', status: 'active', note: '', ...extra });
  const service = await create(ENTITY, data({ code: 'TEST-SIE-BASE', minutes: 60 }));
  const careCase = await create('cases', { caseNo: 'TEST-SIE-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = data => insert(app.db, admin.org, ENTITY, data); // Explicit INSERT-only synthetic imports; no real database or normal-write claim.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, careCase, services, service, plan, shift, data, state, imported, approve };
}

test('real eight-field create and exact price boundaries retain text, selective changes, no-op history and actual actors', async t => {
  const f = await fixture(t);
  for (const [text, cents] of [['0', 0], ['0.01', 1], ['123.45', 12345], ['10000000.00', 1000000000]]) {
    const e = editorFor(), p = e.buildPayload(values(e, { code: ' TEST-' + id() + ' ', name: ' 合成🙂　服務 ', unitPrice: text, note: '\n合成原文<&>  ' }));
    assert.deepEqual(Object.keys(p), keys); const first = await f.create(ENTITY, p); e.confirm(first, f.admin.org, p); assert.equal(first.unitPriceCents, cents); assert.equal(first.minutes, 30); assert.equal(first.name, p.name);
    const edit = editorFor(first), update = edit.buildPayload(values(edit, { note: '  督導更新\n原文  ' })); assert.deepEqual(update, { note: '  督導更新\n原文  ' });
    const second = await f.patch(ENTITY, first, update, f.clients.supervisor); edit.confirm(second, f.admin.org, update);
    const e2 = editorFor(second), noOp = e2.buildPayload(values(e2, { unitPrice: text })); assert.deepEqual(noOp, {});
    const third = await f.patch(ENTITY, second, noOp); e2.confirm(third, f.admin.org, noOp); assert.equal(third.version, 3);
    const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.equal(h.status, 200);
    assert.deepEqual(h.body.items.map(x => x.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
    assert.deepEqual(projection(h.body.items[0].snapshot), projection(second)); assert.equal(h.body.items[2].snapshot.note, p.note); assert.deepEqual(f.state(), before);
    const audits = f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id, 'record.update').map(x => JSON.parse(x.detail)); assert.deepEqual(audits.map(x => x.fields), [['note'], []]);
  }
});

test('normal API CRLF and year0000 stay exact when omitted; explicit repair or optional clear creates an honest next version', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ code: 'TEST-CR\r\nLF', name: '合成\r\n名稱', validFrom: '0000-02-29', validTo: '2026-12-31', note: 'PRIVATE\r\n原文' })), e = editorFor(first);
  for (const name of ['code', 'name', 'validFrom', 'note']) { assert.equal(e.needsIntent(name), true); assert.equal(e.initial[name], ''); }
  assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
  const p = e.buildPayload({ status: 'inactive' }), second = await f.patch(ENTITY, first, p, f.clients.supervisor); e.confirm(second, f.admin.org, p);
  for (const name of ['code', 'name', 'validFrom', 'note']) assert.deepEqual(second[name], first[name]);
  const edit = editorFor(second), replace = edit.buildPayload(values(edit, { codeIntent: 'replace', code: ' TEST-已修復 ', nameIntent: 'replace', name: ' 合成新名稱 ', validFromIntent: 'clear', validTo: '', noteIntent: 'replace', note: ' 新文字\n' }));
  const third = await f.patch(ENTITY, second, replace); edit.confirm(third, f.admin.org, replace); assert.equal(third.validFrom, ''); assert.equal(third.validTo, '');
  const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.equal(h.body.items.at(-1).snapshot.validFrom, '0000-02-29'); assert.equal(h.body.items.at(-1).snapshot.note, first.note); assert.deepEqual(f.state(), before);
});

test('imported nonstring required values and unusual price values are preserved only to the extent the unchanged merged API allows', async t => {
  const f = await fixture(t), special = JSON.parse('{"__proto__":{"private":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  for (const original of [f.data({ code: 0, name: false, minutes: '30', unitPriceCents: false, validFrom: null, validTo: false, note: special }), f.data({ code: special, name: ['nonempty'], minutes: {}, unitPriceCents: -1, validFrom: 0, note: ['PRIVATE'] }), f.data({ name: 0, minutes: true, unitPriceCents: { nested: 'PRIVATE' } }), f.data({ minutes: [30], unitPriceCents: '1000000001' })]) {
    const first = f.imported(original), e = editorFor(first), p = e.buildPayload({ status: 'inactive' }); assert.deepEqual(p, { status: 'inactive' });
    const second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p);
    for (const k of keys.filter(k => k !== 'status')) assert.deepEqual(second[k], first[k]);
    assert.ok(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal({}.private, undefined);
    const before = f.state(), h = await f.request(f.admin, 'GET', history(second)); assert.deepEqual(projection(h.body.items[0].comparison.previousSnapshot), projection(first)); assert.equal(h.body.items.at(-1).actor, null); assert.deepEqual(f.state(), before);
  }
  const data = f.data(); for (const k of ['validFrom', 'validTo', 'note']) delete data[k];
  const first = f.imported(data), e = editorFor(first), p = e.buildPayload({ name: '只改名稱' }), second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p);
  for (const k of ['validFrom', 'validTo', 'note']) assert.equal(Object.hasOwn(second, k), false);
  const e2 = editorFor(second), clear = e2.buildPayload(values(e2, { validFromIntent: 'clear', validToIntent: 'clear', noteIntent: 'clear' })); assert.deepEqual(clear, { validFrom: '', validTo: '', note: '' });
  const third = await f.patch(ENTITY, second, clear); e2.confirm(third, f.admin.org, clear);
});

test('missing/null/empty required data, invalid status and truthy dates still fail original merged guards until explicit repair', async t => {
  const f = await fixture(t);
  for (const key of ['code', 'name', 'minutes', 'unitPriceCents']) for (const bad of [undefined, null, '', []]) {
    const data = f.data(); if (bad === undefined) delete data[key]; else data[key] = bad;
    const first = f.imported(data), e = editorFor(first); assert.deepEqual(e.buildPayload(e.initial), {});
    const before = f.state(), result = await f.request(f.admin, 'PATCH', route(first), { version: 1 }); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'REQUIRED'); assert.deepEqual(f.state(), before);
    const control = key === 'unitPriceCents' ? 'unitPrice' : key, value = key === 'minutes' ? 30 : key === 'unitPriceCents' ? '0.01' : ' TEST-修復-' + id();
    const p = e.buildPayload(values(e, { [control]: value, ...(e.needsIntent(control) ? { [control + 'Intent']: 'replace' } : {}) }));
    const second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p); assert.equal(second[key], key === 'unitPriceCents' ? 1 : value);
  }
  for (const [key, bad, code, replacement] of [['status', 'constructor', 'INVALID_STATUS', 'active'], ['validFrom', '2026-02-30', 'INVALID_DATE', '2026-01-01'], ['validTo', {}, 'INVALID_DATE', '2026-12-31'], ['minutes', false, 'INVALID_NUMBER', 30], ['minutes', 0, 'INVALID_NUMBER', 30], ['minutes', '1441', 'INVALID_NUMBER', 30]]) {
    const first = f.imported(f.data({ [key]: bad })), e = editorFor(first), before = f.state(), result = await f.request(f.admin, 'PATCH', route(first), { version: 1, ...e.buildPayload(e.initial) });
    assert.equal(result.status, 422); assert.equal(result.body.error.code, code); assert.deepEqual(f.state(), before);
    const p = e.buildPayload(values(e, { [key + 'Intent']: 'replace', [key]: replacement })); const second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p);
  }
});

test('normal API retains payload type, integer, text length and date-order guards without implicit helper validation of keep', async t => {
  const f = await fixture(t), item = f.service, before = f.state();
  for (const data of [{ unitPriceCents: false }, { unitPriceCents: '1' }, { unitPriceCents: 1.5 }, { unitPriceCents: -1 }, { unitPriceCents: 1000000001 }, { minutes: 0 }, { minutes: 1441 }, { minutes: 30.5 }, { minutes: '30' }, { name: false }, { code: [] }, { note: {} }, { code: 'x'.repeat(501) }, { note: 'x'.repeat(10001) }, { validFrom: '2026-02-30' }, { status: 'constructor' }, { unitPrice: '0.01' }]) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...data }); assert.equal(result.status, 422, JSON.stringify(data));
  }
  const e = editorFor(item), reverse = e.buildPayload({ validFrom: '2026-12-31', validTo: '2026-01-01' });
  const rejected = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...reverse }); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'DATE_RANGE'); assert.deepEqual(f.state(), before);
  const same = e.buildPayload({ validFrom: '2026-10-09', validTo: '2026-10-09' }), updated = await f.patch(ENTITY, item, same); e.confirm(updated, f.admin.org, same);
  assert.equal(updated.validFrom, updated.validTo);
});

test('true POST replay, same-org duplicate code and competing CAS edits preserve exact payload and never add failed writes', async t => {
  const f = await fixture(t), e = editorFor(), p = e.buildPayload(values(e, { code: 'TEST-ONCE', name: '合成一次', unitPrice: '0.01' })), headers = { 'Idempotency-Key': 'synthetic-service-edit-once' };
  const first = await f.request(f.admin, 'POST', '/api/service-items', p, headers); assert.equal(first.status, 201); e.confirm(first.body.item, f.admin.org, p);
  const afterCommit = f.state(), replay = await f.request(f.admin, 'POST', '/api/service-items', p, headers); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.state(), afterCommit);
  const keyConflict = await f.request(f.admin, 'POST', '/api/service-items', { ...p, name: 'different' }, headers); assert.equal(keyConflict.status, 409); assert.equal(keyConflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const duplicate = await f.request(f.admin, 'POST', '/api/service-items', p); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'DUPLICATE_CODE'); assert.deepEqual(f.state(), afterCommit);
  const old = first.body.item, captured = editorFor(old), pending = captured.buildPayload({ unitPrice: '0.29' }), fresh = await f.patch(ENTITY, old, { name: '合成督導已更新' }, f.clients.supervisor), before = f.state();
  const stale = await f.request(f.admin, 'PATCH', route(old), { version: old.version, ...pending }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  const duplicatePatch = await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, code: f.service.code }); assert.equal(duplicatePatch.status, 409); assert.equal(duplicatePatch.body.error.code, 'DUPLICATE_CODE');
  assert.deepEqual(pending, { unitPriceCents: 29 }); assert.throws(() => captured.confirm(fresh, f.admin.org, pending), /未確認/); assert.deepEqual((await f.request(f.admin, 'GET', route(old))).body.item, fresh); assert.deepEqual(f.state(), before);
});

test('prepared edit and status actions retain four-role, org, CSRF and caregiver referenced-item/active-link scopes', async t => {
  const f = await fixture(t), e = editorFor(f.service), p = e.buildPayload({ note: '合成安全編輯' });
  const unrelated = await f.create(ENTITY, f.data()), org = await f.create('organizations', { name: '合成服務乙機構' }), other = { ...f.admin, org: org.id }, foreign = await f.create(ENTITY, f.data({ code: f.service.code }), other);
  let before = f.state();
  for (const client of [f.clients.finance, f.clients.caregiver]) {
    for (const data of [p, { status: 'inactive' }]) assert.equal((await f.request(client, 'PATCH', route(f.service), { version: 1, ...data })).status, 403);
    assert.equal((await f.request(client, 'POST', '/api/service-items', f.data())).status, 403);
  }
  for (const [client, item] of [[other, f.service], [f.admin, foreign]]) for (const url of [route(item), history(item), history(item, false)]) assert.equal((await f.request(client, 'GET', url)).status, 404);
  assert.equal((await f.request(other, 'PATCH', route(f.service), { version: 1, ...p })).status, 404);
  for (const csrf of ['', 'invalid']) assert.equal((await f.request(f.admin, 'PATCH', route(f.service), { version: 1, ...p }, { 'X-CSRF-Token': csrf })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(f.service), { version: 1, ...p }, { Origin: 'https://untrusted.example.test' })).status, 403);
  for (const url of [route(f.service), history(f.service), history(f.service, false)]) for (const client of Object.values(f.clients)) assert.equal((await f.request(client, 'GET', url)).status, 200);
  for (const url of [route(unrelated), history(unrelated), history(unrelated, false)]) assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 404);
  assert.deepEqual(f.state(), before);
  const second = await f.patch(ENTITY, f.service, p, f.clients.supervisor); e.confirm(second, f.admin.org, p);
  const captured = editorFor(second), inactive = await f.patch(ENTITY, second, { status: 'inactive' }); captured.confirm(inactive, f.admin.org, { status: 'inactive' }); before = f.state();
  for (const url of [route(inactive), history(inactive), history(inactive, false)]) assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 200, 'inactive items remain readable when current own shifts reference them');
  const h = await f.request(f.admin, 'GET', history(inactive)); assert.deepEqual(h.body.items.map(x => x.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]); assert.deepEqual(f.state(), before);
  await f.patch('employees', f.employee, { status: 'inactive' }); before = f.state();
  for (const url of [route(inactive), history(inactive), '/api/service-items']) assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 403); assert.deepEqual(f.state(), before);
});

test('malformed success confirmation after a real commit cannot silently coerce preserved fields or undo the commit', async t => {
  const f = await fixture(t), data = f.data({ minutes: '30', unitPriceCents: false }); delete data.note;
  const first = f.imported(data), e = editorFor(first), p = e.buildPayload({ name: '合成已提交名稱' }), current = await f.patch(ENTITY, first, p), before = f.state();
  for (const reply of [null, [], { ...current, id: 'wrong' }, { ...current, orgId: 'wrong' }, { ...current, version: 1 }, { ...current, minutes: 30 }, { ...current, unitPriceCents: 0 }, { ...current, note: '' }, { ...current, name: 'not-committed' }]) assert.throws(() => e.confirm(reply, f.admin.org, p), /未確認/);
  assert.deepEqual((await f.request(f.admin, 'GET', route(current))).body.item, current); e.confirm(current, f.admin.org, p); assert.deepEqual(e.buildPayload({ name: '合成已提交名稱' }), p); assert.deepEqual(f.state(), before);
});

test('price and activation/date changes have no invented in-use lock, preserve approved billing, and gate only subsequent service use', async t => {
  const f = await fixture(t), approved = await f.approve(), shiftBefore = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item;
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  const e = editorFor(f.service), price = e.buildPayload({ unitPrice: '0.01', minutes: 1, name: '合成更新主檔' });
  let current = await f.patch(ENTITY, f.service, price); e.confirm(current, f.admin.org, price);
  current = await f.patch(ENTITY, current, { status: 'inactive' });
  const futureShift = { caseId: f.careCase.id, employeeId: f.employee.id, carePlanId: f.plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: f.services };
  let before = f.state(), rejected = await f.request(f.admin, 'POST', '/api/shifts', futureShift); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  current = await f.patch(ENTITY, current, { status: 'active', validFrom: '2026-11-01' }); before = f.state();
  rejected = await f.request(f.admin, 'POST', '/api/shifts', futureShift); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  const clear = editorFor(current), p = clear.buildPayload({ validFrom: '', validTo: '' }); current = await f.patch(ENTITY, current, p); clear.confirm(current, f.admin.org, p);
  const addedShift = await f.create('shifts', futureShift); assert.equal(addedShift.services[0].serviceItemId, current.id);
  await f.patch('employees', f.employee, { hourlyRateCents: 99999 }); before = f.state();
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item, shiftBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 12345); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.deepEqual(f.state(), before);
});

test('all31 report exits, both versioned BLOBs, six immutable triggers and full11-table readonly state remain intact', async t => {
  const f = await fixture(t), approved = await f.approve();
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.careCase.id, title: '合成PDF', ...filePayload(PDF_BYTES) });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  const editor = editorFor(f.service), payload = editor.buildPayload({ note: ' 合成只改備註\n' }), current = await f.patch(ENTITY, f.service, payload); editor.confirm(current, f.admin.org, payload);
  const urls = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(k => [`/api/reports/${k}?month=2026-10`, `/api/reports/${k}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-09' : ''}`);
  for (const suffix of ['', '/export', '.csv']) urls.push('/api/employee-report' + suffix); assert.equal(urls.length, 31);
  const schema = f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), before = f.state(); assert.equal(schema.length, 6); assert.equal(Object.keys(before.tables).length, 11); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  const reports = async () => { const result = {}; for (const url of urls) { const r = await f.request(f.admin, 'GET', url); assert.equal(r.status, 200, url); result[url] = typeof r.body === 'string' ? r.body : Object.fromEntries(Object.entries(r.body).filter(([key]) => key !== 'generatedAt')); } return result; };
  const first = await reports();
  for (const [url, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const r = await f.request(f.admin, 'GET', url + suffix); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes); assert.equal(sha(r.bytes), sha(bytes)); }
  for (const client of Object.values(f.clients)) for (const url of [route(current), history(current), history(current, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  assert.deepEqual(await reports(), first); assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  for (const client of [f.clients.supervisor, f.clients.caregiver]) assert.equal(Object.hasOwn((await f.request(client, 'GET', '/api/service-records/' + approved.id)).body.item, 'billingSnapshot'), false);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), schema);
});
