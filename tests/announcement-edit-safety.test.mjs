import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, now, business, insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

import { createAnnouncementEditor } from '../public/data/announcement-editor.js';

const ENTITY = 'announcements';
const password = 'synthetic-announcement-edit-password';
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const history = (item, query = 'compare=previous', entity = ENTITY) => `/api/${entity}/${item.id}/history${query ? '?' + query : ''}`;
const actor = client => ({ id: client.user.id, name: client.user.name });
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, bytes, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成公告管理者', email: 'announcement-edit-admin@example.test', password, organizationName: '合成公告甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: setup.body.organizations[0].id, user: result.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin) {
    const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成公告居服員', employeeNo: 'TEST-AEDIT-EMP', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@announcement-edit.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成公告個案甲', caseNo: 'TEST-AEDIT-CA' });
  const caseB = await create('cases', { name: '合成公告個案乙', caseNo: 'TEST-AEDIT-CB', status: 'paused' });
  const service = await create('service-items', { code: 'TEST-AEDIT-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services });
  const data = overrides => ({ title: '合成公告標題', body: '合成公告內容', audience: 'all', status: 'draft', ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  // These explicit imported/corrupt fixtures exist only in this memory database.
  function imported(fields = {}, version = 1) {
    const time = now(), item = { ...data(fields), id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, ENTITY, JSON.stringify(business(item)), version, time, time);
    return item;
  }
  function addSnapshot(item, version, changes = {}, scope = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(scope.orgId || admin.org, scope.entity || ENTITY, item.id, version, JSON.stringify(snapshot), now(), 'baseline');
    return snapshot;
  }
  function auditEvent(item, changes = {}) {
    const { orgId = admin.org, entity = ENTITY, recordId = item.id, userId = admin.user.id, action = 'record.update', detail = { version: item.version }, rawDetail } = changes;
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(detail), now());
  }
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const response = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const confirmed = await request(admin, 'GET', `/api/service-records/${record.id}`);
    assert.equal(confirmed.status, 200); return confirmed.body.item;
  }
  return { app, request, create, patch, admin, clients, employee, caseA, caseB, service, plan, shift, data, state, imported, addSnapshot, auditEvent, approve };
}

const editorFor = existing => createAnnouncementEditor({ existing });
const formValues = (editor, changes = {}) => ({ ...editor.initial, ...changes });
const route = item => `/api/announcements/${item.id}`;
const projection = item => Object.fromEntries(['title', 'body', 'audience', 'status'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));

test('real create, selective edit, reverted values and no-op PATCH preserve saved text, version history and precise actors', async t => {
  const f = await fixture(t), create = editorFor(), payload = create.buildPayload(formValues(create, { title: '  合成🙂公告  ', body: '\n合成原文\n<&>  ' }));
  const first = await f.create(ENTITY, payload); assert.equal(create.confirm(first, f.admin.org, payload), first);
  const editor = editorFor(first), update = editor.buildPayload(formValues(editor, { body: '  合成督導新內容\n' })); assert.deepEqual(update, { body: '  合成督導新內容\n' });
  const second = await f.patch(ENTITY, first, update, f.clients.supervisor); editor.confirm(second, f.admin.org, update);
  assert.equal(second.title, first.title); assert.equal(second.audience, 'all'); assert.equal(second.status, 'draft');
  const e2 = editorFor(second), noOp = e2.buildPayload(formValues(e2, { title: second.title })); assert.deepEqual(noOp, {});
  const third = await f.patch(ENTITY, second, noOp); assert.equal(third.version, 3); e2.confirm(third, f.admin.org, noOp);
  const auditRows = f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id, 'record.update').map(r => JSON.parse(r.detail));
  assert.deepEqual(auditRows.map(r => r.fields), [['body'], []]);
  const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.equal(h.status, 200);
  assert.deepEqual(h.body.items.map(r => r.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
  assert.deepEqual(projection(h.body.items[0].snapshot), projection(h.body.items[1].snapshot)); assert.equal(h.body.items[2].snapshot.body, first.body); assert.deepEqual(f.state(), before);
});

test('normal API unknown audience and CRLF remain exact when omitted and only explicit replace or clear rewrites them', async t => {
  const f = await fixture(t);
  for (const audience of ['__proto__', 'constructor', '未知\r\n對象', '']) {
    const first = await f.create(ENTITY, f.data({ title: '合成\r\n原標題', body: '合成\r\n原內容', audience })), editor = editorFor(first);
    assert.deepEqual(editor.buildPayload(editor.initial), {}); assert.ok(!JSON.stringify(editor.initial).includes('原標題'));
    const keep = editor.buildPayload(formValues(editor, { status: 'published' })); assert.deepEqual(keep, { status: 'published' });
    const second = await f.patch(ENTITY, first, keep, f.clients.supervisor); editor.confirm(second, f.admin.org, keep);
    assert.equal(second.title, first.title); assert.equal(second.body, first.body); assert.equal(second.audience, audience);
    const e2 = editorFor(second), replacement = e2.buildPayload(formValues(e2, { titleIntent: 'replace', title: '  新標題  ', bodyIntent: 'replace', body: '合成\n新內容', audienceIntent: 'replace', audience: 'caregiver' }));
    const third = await f.patch(ENTITY, second, replacement); e2.confirm(third, f.admin.org, replacement); assert.equal(third.audience, 'caregiver');
    const separate = await f.create(ENTITY, f.data({ audience })), clearing = editorFor(separate), clear = clearing.buildPayload(formValues(clearing, { audienceIntent: 'clear' }));
    assert.deepEqual(clear, audience === '' ? {} : { audience: '' });
    const cleared = await f.patch(ENTITY, separate, clear); clearing.confirm(cleared, f.admin.org, clear); assert.equal(cleared.audience, '');
    const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.equal(h.body.items.at(-1).snapshot.audience, audience); assert.equal(h.body.items.at(-1).snapshot.body, first.body); assert.deepEqual(f.state(), before);
  }
});

test('legal imported nonempty nontext values preserve their JSON and own presence through real omitted-field PATCH', async t => {
  const f = await fixture(t), special = JSON.parse('{"__proto__":{"private":"nested"},"constructor":[false,0],"prototype":null}');
  for (const [title, body, audience] of [[0, false, null], [false, 0, ['all']], [special, ['nonempty', null, false], { nested: ['PRIVATE'] }]]) {
    // Explicit import-only memory fixture; normal POST does not accept these types.
    const first = insert(f.app.db, f.admin.org, ENTITY, f.data({ title, body, audience })), editor = editorFor(first);
    const payload = editor.buildPayload(formValues(editor, { status: 'published' })); assert.deepEqual(payload, { status: 'published' });
    const second = await f.patch(ENTITY, first, payload); editor.confirm(second, f.admin.org, payload);
    assert.deepEqual(second.title, title); assert.deepEqual(second.body, body); assert.deepEqual(second.audience, audience);
    assert.ok(!JSON.stringify(editor.fields).includes('PRIVATE')); assert.equal({}.private, undefined);
    const before = f.state(), h = await f.request(f.admin, 'GET', history(second)); assert.deepEqual(projection(h.body.items[0].comparison.previousSnapshot), projection(first)); assert.deepEqual(f.state(), before);
  }
  const data = f.data(); delete data.audience;
  const missing = insert(f.app.db, f.admin.org, ENTITY, data), editor = editorFor(missing), payload = editor.buildPayload(formValues(editor, { body: '只改內文' }));
  const current = await f.patch(ENTITY, missing, payload); editor.confirm(current, f.admin.org, payload); assert.equal(Object.hasOwn(current, 'audience'), false);
  const before = f.state(); for (const bad of [{ title: false }, { body: 0 }, { audience: null }, { audience: ['all'] }]) assert.equal((await f.request(f.admin, 'POST', '/api/announcements', f.data(bad))).status, 422); assert.deepEqual(f.state(), before);
});

test('merged REQUIRED and status failures remain original API422 until the invalid saved field is explicitly replaced', async t => {
  const f = await fixture(t);
  for (const name of ['title', 'body', 'status']) for (const bad of [undefined, null, '', []]) {
    const data = f.data(); if (bad === undefined) delete data[name]; else data[name] = bad;
    const first = insert(f.app.db, f.admin.org, ENTITY, data), editor = editorFor(first), keep = editor.buildPayload(editor.initial); assert.deepEqual(keep, {});
    const before = f.state(), result = await f.request(f.admin, 'PATCH', route(first), { version: first.version, ...keep });
    assert.equal(result.status, 422); assert.equal(result.body.error.code, name === 'status' ? 'INVALID_STATUS' : 'REQUIRED'); assert.deepEqual(f.state(), before);
    const changes = { [name]: name === 'status' ? 'draft' : '  明確取代保存欄  ' }; if (editor.needsIntent(name)) changes[name + 'Intent'] = 'replace';
    const payload = editor.buildPayload(formValues(editor, changes)), current = await f.patch(ENTITY, first, payload); editor.confirm(current, f.admin.org, payload); assert.equal(current[name], changes[name]);
  }
  const invalidStatus = insert(f.app.db, f.admin.org, ENTITY, f.data({ status: '__proto__' })), e = editorFor(invalidStatus), before = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', route(invalidStatus), { version: 1, ...e.buildPayload(e.initial) })).status, 422); assert.deepEqual(f.state(), before);
});

test('API outcome replay retains one POST record with one idempotency key and CAS errors never overwrite a newer edit', async t => {
  const f = await fixture(t), editor = editorFor(), payload = editor.buildPayload(formValues(editor, { title: '合成未知結果', body: '原文' })), headers = { 'Idempotency-Key': 'synthetic-announcement-edit-once' };
  const first = await f.request(f.admin, 'POST', '/api/announcements', payload, headers); assert.equal(first.status, 201);
  // The first request committed; simulate a caller that could not confirm its response without undoing that write.
  const beforeReplay = f.state(), replay = await f.request(f.admin, 'POST', '/api/announcements', payload, headers); assert.deepEqual(replay.body, first.body); editor.confirm(replay.body.item, f.admin.org, payload); assert.deepEqual(f.state(), beforeReplay);
  const conflict = await f.request(f.admin, 'POST', '/api/announcements', { ...payload, body: 'different' }, headers); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), beforeReplay);
  const old = first.body.item, oldEditor = editorFor(old), pending = oldEditor.buildPayload(formValues(oldEditor, { body: '合成尚未保存輸入' }));
  const fresh = await f.patch(ENTITY, old, { body: '另一操作者已更新' }, f.clients.supervisor), before = f.state();
  const stale = await f.request(f.admin, 'PATCH', route(old), { version: old.version, ...pending }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(pending, { body: '合成尚未保存輸入' }); assert.throws(() => oldEditor.confirm(fresh, f.admin.org, pending), /未確認/);
  assert.equal((await f.request(f.admin, 'GET', route(old))).body.item.body, '另一操作者已更新'); assert.deepEqual(f.state(), before);
});

test('prepared edit and withdrawal preserve original roles, organization isolation, CSRF and current/history read scopes', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ status: 'published' })), editor = editorFor(first), payload = editor.buildPayload(formValues(editor, { body: '安全編輯' }));
  const org = await f.create('organizations', { name: '合成公告編輯乙機構' }), other = { ...f.admin, org: org.id }, foreign = await f.create(ENTITY, f.data(), other);
  let before = f.state();
  for (const caller of [f.clients.finance, f.clients.caregiver]) for (const data of [payload, { status: 'draft' }]) { const result = await f.request(caller, 'PATCH', route(first), { version: 1, ...data }); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN'); }
  assert.equal((await f.request(other, 'PATCH', route(first), { version: 1, ...payload })).status, 404);
  assert.equal((await f.request(f.admin, 'PATCH', route(foreign), { version: 1, ...payload })).status, 404);
  for (const token of ['', 'invalid']) assert.equal((await f.request(f.admin, 'PATCH', route(first), { version: 1, ...payload }, { 'X-CSRF-Token': token })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(first), { version: 1, ...payload }, { Origin: 'https://untrusted.example.test' })).status, 403); assert.deepEqual(f.state(), before);
  const second = await f.patch(ENTITY, first, payload, f.clients.supervisor); editor.confirm(second, f.admin.org, payload);
  const e2 = editorFor(second), withdrawn = await f.patch(ENTITY, second, { status: 'draft' }); e2.confirm(withdrawn, f.admin.org, { status: 'draft' });
  assert.equal(withdrawn.body, second.body); before = f.state();
  for (const url of [route(withdrawn), history(withdrawn, ''), history(withdrawn)]) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 404);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', url)).status, 200);
  }
  const h = await f.request(f.admin, 'GET', history(withdrawn)); assert.deepEqual(h.body.items.map(r => r.version), [3, 2, 1]); assert.deepEqual(h.body.items.map(r => r.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]); assert.deepEqual(f.state(), before);
});

test('response confirmation rejects malformed2xx projections after a real commit without pretending to roll it back', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ audience: '合成未知對象' })), editor = editorFor(first), payload = editor.buildPayload(formValues(editor, { body: '合成已提交的新文' })), current = await f.patch(ENTITY, first, payload);
  const before = f.state();
  for (const response of [null, { ...current, id: 'wrong' }, { ...current, orgId: 'wrong' }, { ...current, version: 1 }, { ...current, body: 'not committed' }, { ...current, audience: 'all' }]) assert.throws(() => editor.confirm(response, f.admin.org, payload), /未確認/);
  const missing = { ...current }; delete missing.audience; assert.throws(() => editor.confirm(missing, f.admin.org, payload), /未確認/);
  assert.deepEqual(editor.buildPayload(formValues(editor, { body: '合成已提交的新文' })), payload);
  assert.deepEqual((await f.request(f.admin, 'GET', route(current))).body.item, current); editor.confirm(current, f.admin.org, payload); assert.deepEqual(f.state(), before);
});

test('safe editing leaves independent BLOB bytes, immutable triggers, billing and all31 report outlets unchanged across reads', async t => {
  const f = await fixture(t), approved = await f.approve();
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成PDF', ...filePayload(PDF_BYTES) });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  const first = await f.create(ENTITY, f.data({ title: '合成\r\n原文', audience: '未知對象', status: 'published' })), editor = editorFor(first), patch = editor.buildPayload(formValues(editor, { body: '合成新內容' }));
  const current = await f.patch(ENTITY, first, patch, f.clients.supervisor); editor.confirm(current, f.admin.org, patch);
  await f.patch('employees', f.employee, { hourlyRateCents: 99999 }); await f.patch('service-items', f.service, { unitPriceCents: 88888 });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(k => [`/api/reports/${k}?month=2026-10`, `/api/reports/${k}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-08' : ''}`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix); assert.equal(routes.length, 31);
  const before = f.state(), schema = f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(); assert.equal(schema.length, 6); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  const readReports = async () => { const output = {}; for (const url of routes) { const r = await f.request(f.admin, 'GET', url); assert.equal(r.status, 200, url); output[url] = typeof r.body === 'string' ? r.body : Object.fromEntries(Object.entries(r.body).filter(([k]) => k !== 'generatedAt')); } return output; };
  const reports = await readReports();
  for (const [url, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const r = await f.request(f.admin, 'GET', url + suffix); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes); assert.equal(sha(r.bytes), sha(bytes)); }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const query of ['', 'compare=previous']) assert.equal((await f.request(caller, 'GET', history(current, query))).status, 200);
  assert.deepEqual(await readReports(), reports); assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body.totals.amountCents, 37035); assert.equal((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body.totals.amountCents, 18800);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), schema);
});
