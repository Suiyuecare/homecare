import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { createAssessmentEditor } from '../public/data/assessment-editor.js';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const catalog = JSON.parse(readFileSync(new URL('../public/data/assessment-templates.json', import.meta.url), 'utf8'));
const template = catalog.find(item => item.id === 'assessment-01');
const password = 'synthetic-assessment-editor-password';
const date = '2026-10-08';
const entity = 'assessments';
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const route = item => `/api/assessments/${item.id}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function editorFor(row, selected = template) { return createAssessmentEditor(selected, row, date); }
function valuesFor(editor, changes = {}) { return { ...editor.initial, ...changes }; }
function known(selected, type) { return selected.fields.find(field => field.type === type); }
function expectNoAnswers(payload) { assert.equal(Object.hasOwn(payload, 'answers'), false); }
function expectError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body.error.code, code);
}

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extraHeaders = {}) {
    const headers = { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders };
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
    const response = await fetch(base + url, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers, bytes };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成編輯安全管理者', email: 'editor-admin@example.test', password, organizationName: '合成編輯安全甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const toClient = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = toClient(setup), clients = { admin };
  async function create(kind, data, caller = admin, headers = {}) {
    const response = await request(caller, 'POST', '/api/' + kind, data, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(kind, item, data, caller = admin) {
    const response = await request(caller, 'PATCH', `/api/${kind}/${item.id}`, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employee = await create('employees', { name: '合成編輯居服員', employeeNo: 'TEST-AE-EMP', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@assessment-editor.example.test';
    await create('users', { name: '合成編輯' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = toClient(login);
  }
  const caseA = await create('cases', { name: '合成編輯個案甲', caseNo: 'TEST-AE-CA' });
  const caseB = await create('cases', { name: '合成編輯個案乙', caseNo: 'TEST-AE-CB', status: 'paused' });
  const service = await create('service-items', { code: 'TEST-AE-SERVICE', name: '合成編輯服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date, startTime: '09:00', endTime: '10:00', services });
  const data = overrides => ({ caseId: caseA.id, templateId: template.id, date, answers: { q001: date, q004: '合成原答案' }, status: 'draft', ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  async function history(item, caller = admin) {
    const response = await request(caller, 'GET', route(item) + '/history?compare=previous'); assert.equal(response.status, 200); return response.body;
  }
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const review = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: 1, decision: 'approved', reviewNote: '合成已核閱' }); assert.equal(review.status, 200);
    return (await request(admin, 'GET', `/api/service-records/${record.id}`)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, caseA, caseB, service, plan, shift, data, state, history, approve };
}

test('safe editor metadata and one real answer edit preserve all other legal answer JSON and exact historical actors', async t => {
  const f = await fixture(t);
  const answers = { q001: date, q004: '  合成原文  ', q006: 0, q007: false, q008: null, q009: ['原順序', '', 3], q010: { nested: ['合成巢狀答案', null] },
    caseId: 'ANSWER-CASE', templateId: 'ANSWER-TEMPLATE', date: 'ANSWER-DATE', status: 'ANSWER-STATUS', id: 'ANSWER-ID', version: 999,
    answers: { q004: '不能覆蓋真正題項' }, unknown: { keep: [false, 0, ''] }, billingSnapshot: '答案內合法同名鍵' };
  const first = await f.create(entity, f.data({ answers }));
  const source = freeze(clone(first)), original = clone(source), editor = editorFor(source);
  assert.equal(editor.editing, true); assert.equal(editor.answersEditable, true); assert.equal(editor.hasPreservedAnswers, true);
  assert.equal(editor.initial.caseId, first.caseId); assert.equal(editor.initial.date, first.date); assert.equal(editor.initial.status, first.status);
  assert.equal(editor.initial.q004, answers.q004); assert.equal(editor.initial.q006, '');
  assert.ok(!JSON.stringify({ initial: editor.initial, questions: editor.questions }).includes('合成巢狀答案'));
  const metadata = editor.buildPayload(valuesFor(editor, { caseId: f.caseB.id, date: '2026-10-09', status: 'submitted' }));
  expectNoAnswers(metadata); assert.deepEqual(metadata, { caseId: f.caseB.id, templateId: template.id, date: '2026-10-09', status: 'submitted' });
  const second = await f.patch(entity, first, metadata, f.clients.supervisor);
  assert.deepEqual(second.answers, answers);
  const metadataAudit = f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=?').all(first.id, 'record.update').map(row => JSON.parse(row.detail)).find(detail => detail.version === 2);
  assert.deepEqual(metadataAudit.fields.sort(), ['caseId', 'date', 'status', 'templateId']);
  const editing = editorFor(freeze(clone(second))), payload = editing.buildPayload(valuesFor(editing, { q004: '  只改這一題  ', status: 'draft' }));
  assert.deepEqual(payload.answers, { ...answers, q004: '  只改這一題  ' });
  assert.equal(payload.templateId, template.id); assert.ok(!Object.keys(payload).some(key => key.startsWith('answerIntent_')));
  const third = await f.patch(entity, second, payload);
  assert.deepEqual(source, original); assert.deepEqual(third.answers, payload.answers);
  assert.equal(Object.hasOwn(third.answers, 'q011'), false, 'absent question must not be added during an edit');
  const before = f.state(), history = await f.history(third);
  assert.deepEqual(history.items.map(row => row.version), [3, 2, 1]);
  assert.deepEqual(history.items.map(row => row.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
  assert.deepEqual(history.items[0].comparison.previousSnapshot, history.items[1].snapshot);
  assert.deepEqual(history.items[1].snapshot.answers, answers); assert.deepEqual(history.items[2].snapshot.answers, answers);
  assert.deepEqual(f.state(), before);
});

test('actual catalog controls use explicit keep, replace and clear without coercion or native-cleaning data loss', async t => {
  const f = await fixture(t), types = {};
  for (const item of catalog) for (const field of item.fields) types[field.type] = (types[field.type] || 0) + 1;
  assert.deepEqual(types, { date: 49, text: 304, textarea: 5, time: 1 });
  const firstEditor = editorFor(null), text = known(template, 'text');
  const createdPayload = firstEditor.buildPayload(valuesFor(firstEditor, { caseId: f.caseA.id, [text.name]: '  合成新建原文  ' }));
  assert.equal(firstEditor.editing, false); assert.equal(createdPayload.templateId, template.id);
  assert.equal(createdPayload.answers[text.name], '  合成新建原文  ');
  const created = await f.create(entity, createdPayload); assert.deepEqual(created.answers, createdPayload.answers);
  assert.throws(() => firstEditor.buildPayload(valuesFor(firstEditor, { caseId: f.caseA.id, q999: '未知注入' })));
  const variants = [
    { type: 'text', saved: '第一行\n第二行', replacement: '  保留空白  ' },
    { type: 'date', saved: '2026-02-30', replacement: '2026-02-28' },
    { type: 'textarea', saved: '第一行\r\n第二行', replacement: '第一行\n第二行' },
    { type: 'time', saved: '24:00', replacement: '23:59' },
  ];
  for (const variant of variants) {
    const selected = catalog.find(item => item.fields.some(field => field.type === variant.type));
    const field = known(selected, variant.type), hidden = { untouched: ['合成未展示', false, null] };
    const first = await f.create(entity, f.data({ templateId: selected.id, answers: { [field.name]: variant.saved, hidden } }));
    const original = freeze(clone(first)), editor = editorFor(original, selected), intent = 'answerIntent_' + field.name;
    const question = editor.questions.find(item => item.name === field.name);
    assert.equal(question.requiresIntent, true); assert.equal(question.intentName, intent); assert.equal(question.initialValue, '');
    assert.equal(editor.initial[field.name], '');
    expectNoAnswers(editor.buildPayload(valuesFor(editor)));
    expectNoAnswers(editor.buildPayload(valuesFor(editor, { [intent]: 'keep', [field.name]: variant.replacement })));
    for (const badIntent of ['remove', '', null, false]) assert.throws(() => editor.buildPayload(valuesFor(editor, { [intent]: badIntent })));
    assert.throws(() => editor.buildPayload(valuesFor(editor, { [intent]: 'replace', [field.name]: variant.saved })));
    assert.throws(() => editor.buildPayload(valuesFor(editor, { [intent]: 'replace', [field.name]: 0 })));
    const cleared = editor.buildPayload(valuesFor(editor, { [intent]: 'clear' }));
    assert.deepEqual(cleared.answers, { [field.name]: '', hidden });
    const clearItem = await f.patch(entity, first, cleared); assert.equal(clearItem.answers[field.name], '');
    // Start a separate edit from its own current version; never borrow a newer CAS version for an old editor.
    const replaceSource = await f.create(entity, f.data({ templateId: selected.id, answers: { [field.name]: variant.saved, hidden } }));
    const replaceEditor = editorFor(freeze(clone(replaceSource)), selected);
    const replacement = replaceEditor.buildPayload(valuesFor(replaceEditor, { [intent]: 'replace', [field.name]: variant.replacement }));
    const replaced = await f.patch(entity, replaceSource, replacement, f.clients.supervisor);
    assert.deepEqual(replaced.answers, { [field.name]: variant.replacement, hidden });
    assert.deepEqual(original, first);
    const compatible = editorFor(replaced, selected);
    expectNoAnswers(compatible.buildPayload(valuesFor(compatible, { [field.name]: variant.replacement })));
    const empty = compatible.buildPayload(valuesFor(compatible, { [field.name]: '' }));
    assert.equal(empty.answers[field.name], '');
    assert.throws(() => compatible.buildPayload(valuesFor(compatible, { answerIntent_q999: 'replace', q999: '不得注入' })));
  }
});

test('own reserved JSON keys survive real HTTP without prototype pollution while malformed imported roots remain metadata-only', async t => {
  const f = await fixture(t), prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  // JSON.parse creates a real own __proto__ key; an object literal would not be equivalent.
  const answers = JSON.parse('{"__proto__":{"syntheticPollution":"do-not-promote"},"constructor":{"prototype":{"syntheticPollution":"nested-only"}},"prototype":["own-key"],"q004":"原文","q006":false}');
  const first = await f.create(entity, f.data({ answers })), frozen = freeze(clone(first)), editor = editorFor(frozen);
  const payload = editor.buildPayload(valuesFor(editor, { q004: '修訂原文' }));
  assert.equal(Object.hasOwn(payload.answers, '__proto__'), true); assert.equal(Object.getPrototypeOf(payload.answers), Object.prototype);
  assert.deepEqual(payload.answers.__proto__, answers.__proto__); assert.deepEqual(payload.answers.constructor, answers.constructor);
  const current = await f.patch(entity, first, payload);
  assert.deepEqual(current.answers, payload.answers); assert.deepEqual(frozen, first);
  assert.equal({}.syntheticPollution, undefined); assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
  const saved = await f.history(current); assert.deepEqual(saved.items[0].snapshot.answers, payload.answers); assert.deepEqual(saved.items[0].comparison.previousSnapshot.answers, answers);
  // These root values cannot be created through the normal API; imports are memory-only fixtures.
  for (const variant of [{ missing: true }, { root: null }, { root: ['合成異常根'] }, { root: '合成異常根' }, { root: 0 }, { root: false }]) {
    const data = f.data(); if (variant.missing) delete data.answers; else data.answers = variant.root;
    const imported = insert(f.app.db, f.admin.org, entity, data), original = freeze(clone(imported)), blocked = editorFor(original);
    assert.equal(blocked.answersEditable, false); assert.ok(blocked.questions.every(question => question.initialValue === ''));
    const metadata = blocked.buildPayload(valuesFor(blocked, { status: 'submitted', date: '2026-10-09' })); expectNoAnswers(metadata);
    const updated = await f.patch(entity, imported, metadata, f.clients.supervisor);
    assert.equal(Object.hasOwn(updated, 'answers'), !variant.missing);
    if (!variant.missing) assert.deepEqual(updated.answers, variant.root);
    assert.deepEqual(original, imported);
    assert.throws(() => blocked.buildPayload(valuesFor(blocked, { q004: '不能替換整包異常根' })));
    const read = await f.history(updated); assert.equal(read.items[0].snapshot.status, 'submitted');
    assert.equal(Object.hasOwn(read.items[0].snapshot, 'answers'), !variant.missing);
  }
  const before = f.state();
  for (const invalid of [null, [], '', 0, false]) expectError(await f.request(f.admin, 'POST', '/api/assessments', f.data({ answers: invalid })), 422);
  assert.deepEqual(f.state(), before); assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});

test('prepared safe payloads retain four real roles, organization references, CSRF and origin enforcement', async t => {
  const f = await fixture(t), first = await f.create(entity, f.data());
  const editor = editorFor(first), payload = editor.buildPayload(valuesFor(editor, { q004: '合成合法修改' }));
  const org = await f.create('organizations', { name: '合成編輯乙機構' }), foreign = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: '合成編輯跨機構個案', caseNo: 'TEST-AE-FOREIGN' }, foreign);
  const foreignItem = await f.create(entity, f.data({ caseId: foreignCase.id }), foreign);
  const before = f.state();
  for (const caller of [f.clients.finance, f.clients.caregiver]) {
    expectError(await f.request(caller, 'POST', '/api/assessments', payload), 403);
    expectError(await f.request(caller, 'PATCH', route(first), { version: first.version, ...payload }), 403);
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', route(first))).status, 200);
  expectError(await f.request(f.clients.caregiver, 'GET', route(first)), 403);
  expectError(await f.request(null, 'GET', route(first)), 401);
  expectError(await f.request(foreign, 'PATCH', route(first), { version: first.version, ...payload }), 404);
  expectError(await f.request(f.admin, 'GET', route(foreignItem)), 404);
  expectError(await f.request({ ...f.admin, org: 'unavailable-org' }, 'PATCH', route(first), { version: first.version, ...payload }), 403);
  for (const caseId of [foreignCase.id, f.employee.id, id()]) {
    const bad = editor.buildPayload(valuesFor(editor, { caseId, q004: '保持輸入' }));
    expectError(await f.request(f.admin, 'PATCH', route(first), { version: first.version, ...bad }), 422, 'INVALID_REFERENCE');
  }
  for (const headers of [{ 'X-CSRF-Token': null }, { 'X-CSRF-Token': 'invalid' }, { Origin: 'https://untrusted.example.test' }]) {
    expectError(await f.request(f.admin, 'PATCH', route(first), { version: first.version, ...payload }, headers), 403);
    expectError(await f.request(f.admin, 'POST', '/api/assessments', payload, headers), 403);
  }
  assert.deepEqual(f.state(), before);
  const changed = await f.patch(entity, first, payload, f.clients.supervisor); assert.equal(changed.answers.q004, '合成合法修改');
  const next = editorFor(changed), moved = await f.patch(entity, changed, next.buildPayload(valuesFor(next, { caseId: f.caseB.id, status: 'submitted' })));
  assert.equal(moved.caseId, f.caseB.id); assert.equal(moved.templateId, template.id);
  // The server's pre-existing unknown-template contract is not narrowed by a catalog-based UI helper.
  const unknown = await f.create(entity, f.data({ templateId: 'synthetic-unknown-template' })); assert.equal(unknown.templateId, 'synthetic-unknown-template');
});

test('POST replay and competing PATCH versions preserve prepared inputs and never silently overwrite another editor', async t => {
  const f = await fixture(t), newEditor = editorFor(null), payload = newEditor.buildPayload(valuesFor(newEditor, { caseId: f.caseA.id, q004: '合成新增冪等' }));
  const headers = { 'Idempotency-Key': 'assessment-editor-stable-create' };
  const created = await f.request(f.admin, 'POST', '/api/assessments', payload, headers); assert.equal(created.status, 201);
  let before = f.state();
  const replay = await f.request(f.admin, 'POST', '/api/assessments', payload, headers); assert.deepEqual(replay.body, created.body); assert.equal(replay.status, 201);
  expectError(await f.request(f.admin, 'POST', '/api/assessments', { ...payload, answers: { ...payload.answers, q004: '不同內容' } }, headers), 409, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.state(), before);
  const first = created.body.item, retained = freeze(clone(first)), staleEditor = editorFor(retained), values = valuesFor(staleEditor, { q004: '合成尚未保存輸入', date: '2026-10-10' });
  const stalePayload = staleEditor.buildPayload(values), originalValues = clone(values), originalPayload = clone(stalePayload);
  const competitor = await f.patch(entity, first, { answers: { ...first.answers, q004: '合成其他人先保存', hidden: { keep: ['競爭者值'] } }, status: 'submitted' }, f.clients.supervisor);
  before = f.state();
  for (let attempt = 0; attempt < 2; attempt++) expectError(await f.request(f.admin, 'PATCH', route(first), { version: first.version, ...stalePayload }), 409, 'VERSION_CONFLICT');
  assert.deepEqual(values, originalValues); assert.deepEqual(stalePayload, originalPayload); assert.deepEqual(retained, first);
  assert.deepEqual(staleEditor.buildPayload(values), stalePayload, 'helper must not fetch or silently adopt a newer version');
  assert.deepEqual((await f.request(f.admin, 'GET', route(first))).body.item, competitor); assert.deepEqual(f.state(), before);
  const refreshed = editorFor(competitor), saved = await f.patch(entity, competitor, refreshed.buildPayload(valuesFor(refreshed, { q004: '合成重讀後明確保存', status: 'draft' })));
  assert.deepEqual(saved.answers.hidden, competitor.answers.hidden);
  const history = await f.history(saved); assert.deepEqual(history.items.map(item => item.version), [3, 2, 1]);
  assert.deepEqual(history.items[0].comparison.previousSnapshot.answers, competitor.answers);
  assert.deepEqual(history.items.map(item => item.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
});

test('full hidden answers count toward both size guards and are never truncated to make an edit fit', async t => {
  const f = await fixture(t), overhead = JSON.stringify({ q004: 'x', hidden: '' }).length;
  const answers = { q004: 'x', hidden: 'h'.repeat(50000 - overhead) };
  assert.equal(JSON.stringify(answers).length, 50000);
  const first = await f.create(entity, f.data({ answers })), frozen = freeze(clone(first)), editor = editorFor(frozen);
  const sameLength = editor.buildPayload(valuesFor(editor, { q004: 'y' })); assert.equal(JSON.stringify(sameLength.answers).length, 50000);
  const exact = await f.patch(entity, first, sameLength); assert.deepEqual(exact.answers, { ...answers, q004: 'y' });
  const currentEditor = editorFor(exact), tooMany = currentEditor.buildPayload(valuesFor(currentEditor, { q004: 'yy' }));
  assert.equal(JSON.stringify(tooMany.answers).length, 50001); assert.equal(tooMany.answers.hidden, answers.hidden);
  let before = f.state(); expectError(await f.request(f.admin, 'PATCH', route(exact), { version: exact.version, ...tooMany }), 422, 'INVALID_FIELD');
  assert.deepEqual(f.state(), before); assert.deepEqual(currentEditor.buildPayload(valuesFor(currentEditor, { q004: 'yy' })), tooMany);
  const metadata = currentEditor.buildPayload(valuesFor(currentEditor, { status: 'submitted' })); expectNoAnswers(metadata);
  const submitted = await f.patch(entity, exact, metadata); assert.deepEqual(submitted.answers, exact.answers);
  const compact = await f.create(entity, f.data({ answers: { q004: 'x', hidden: '中'.repeat(43000) } }));
  const byteEditor = editorFor(compact), text = '中'.repeat(1000), oversized = byteEditor.buildPayload(valuesFor(byteEditor, { q004: text }));
  assert.ok(JSON.stringify(oversized.answers).length < 50000, 'this failure exercises byte size independently of answer character size');
  assert.ok(Buffer.byteLength(JSON.stringify({ version: compact.version, ...oversized })) > 131072);
  before = f.state(); expectError(await f.request(f.admin, 'PATCH', route(compact), { version: compact.version, ...oversized }), 413, 'BODY_TOO_LARGE');
  assert.deepEqual(f.state(), before); assert.equal(oversized.answers.hidden, compact.answers.hidden); assert.equal(oversized.answers.q004, text);
  assert.deepEqual(frozen, first);
});

test('helper and readonly intervals preserve eleven tables, both BLOBs, approved snapshots and all 25 report outlets', async t => {
  const f = await fixture(t), approved = await f.approve();
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 12345);
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成編輯證照', issuedOn: '2026-01-01' });
  const attachment = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成編輯PDF', ...filePayload(PDF_BYTES, '合成編輯.pdf', 'application/pdf') });
  const certAttachment = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成編輯PNG', ...filePayload(PNG_BYTES, '合成編輯.png', 'image/png') });
  await f.patch('employees', f.employee, { hourlyRateCents: 99999 }); await f.patch('service-items', f.service, { unitPriceCents: 88888 });
  await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-09', startTime: '12:00', endTime: '13:00', type: '合成假別' });
  const first = await f.create(entity, f.data({ answers: { q004: '合成原答案', hidden: { untouched: true } } }));
  const schema = f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all();
  assert.equal(schema.filter(item => item.type === 'table').length, 11); assert.equal(schema.filter(item => item.type === 'trigger').length, 6);
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix);
  assert.equal(routes.length, 25);
  async function readReports() {
    const result = {};
    for (const url of routes) { const response = await f.request(f.admin, 'GET', url); assert.equal(response.status, 200, url + ': ' + JSON.stringify(response.body)); result[url] = typeof response.body === 'string' ? response.body : Object.fromEntries(Object.entries(response.body).filter(([key]) => key !== 'generatedAt')); }
    return result;
  }
  const beforeRead = f.state(), reports = await readReports(), frozen = freeze(clone(first)), editor = editorFor(frozen);
  expectNoAnswers(editor.buildPayload(valuesFor(editor)));
  const payload = editor.buildPayload(valuesFor(editor, { q004: '合成安全保存', status: 'submitted' }));
  for (const caller of Object.values(f.clients)) for (const url of ['/api/assessments', route(first), route(first) + '/history', route(first) + '/history?compare=previous']) {
    const response = await f.request(caller, 'GET', url); assert.equal(response.status, caller === f.clients.caregiver ? 403 : 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.caregiver]) for (const [url, bytes] of [[`/api/case-attachments/${attachment.id}/download`, PDF_BYTES], [`/api/certification-attachments/${certAttachment.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) {
    const response = await f.request(caller, 'GET', url + suffix); assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes); assert.equal(sha(response.bytes), sha(bytes));
  }
  assert.deepEqual(f.state(), beforeRead, 'helper and reads must not produce any database writes');
  const current = await f.patch(entity, first, payload, f.clients.supervisor), afterWrite = f.state();
  for (const table of tables.filter(name => !['records', 'record_versions', 'audit'].includes(name))) assert.deepEqual(afterWrite.tables[table], beforeRead.tables[table], table);
  assert.deepEqual(afterWrite.tables.records.filter(row => row.id !== first.id), beforeRead.tables.records.filter(row => row.id !== first.id));
  assert.equal(afterWrite.tables.record_versions.length, beforeRead.tables.record_versions.length + 1);
  assert.equal(afterWrite.tables.audit.length, beforeRead.tables.audit.length + 1);
  assert.deepEqual(await readReports(), reports); assert.deepEqual((await f.request(f.admin, 'GET', `/api/service-records/${approved.id}`)).body.item, approved);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body.totals.amountCents, 37035);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body.totals.amountCents, 18800);
  const history = await f.history(current); assert.deepEqual(history.items[0].comparison.previousSnapshot.answers, first.answers);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    const column = table === 'record_versions' ? 'source' : 'file_name';
    assert.throws(() => f.app.db.prepare(`UPDATE ${table} SET ${column}=?`).run('tamper'), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM ' + table).run(), /immutable/);
  }
  assert.deepEqual(f.state(), afterWrite); assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all(), schema);
});
