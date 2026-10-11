import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';
import { createServiceRecordEditor, createServiceRecordReview } from '../public/data/service-record-editor.js';

const keys = ['shiftId', 'caseId', 'employeeId', 'date', 'actualStart', 'actualEnd', 'services', 'status', 'note', 'reviewNote'];
const controls = ['actualStart', 'actualEnd', 'services', 'note', 'status'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const password = 'synthetic-service-record-safety-password';
const route = item => '/api/service-records/' + item.id;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const projection = item => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const saveUnconfirmed = error => error.code === 'SAVE_UNCONFIRMED';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extra = {}) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成服務紀錄管理者', email: 'admin@record-safety.example.test', password, organizationName: '合成服務紀錄甲機構' });
  assert.equal(setup.status, 201);
  const from = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken,
    org: setup.body.organizations[0].id, user: response.body.user });
  const admin = from(setup), clients = { admin };
  async function create(entity, data, client = admin, extra = {}) {
    const result = await request(client, 'POST', '/api/' + entity, data, extra);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { ...data, version: item.version });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  async function get(entity, item, client = admin) {
    const result = await request(client, 'GET', '/api/' + entity + '/' + item.id);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  async function review(item, payload, client = clients.supervisor, extra = {}) {
    const result = await request(client, 'POST', route(item) + '/review', { version: item.version, ...payload }, extra);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成紀錄居服甲', employeeNo: 'RS-EA', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成紀錄居服乙', employeeNo: 'RS-EB', hourlyRateCents: 26000 });
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA], ['caregiverB', 'caregiver', employeeB]]) {
    const email = key + '@record-safety.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = from(login);
  }
  const caseA = await create('cases', { name: '合成紀錄個案甲', caseNo: 'RS-CA' });
  const caseB = await create('cases', { name: '合成紀錄個案乙', caseNo: 'RS-CB' });
  const serviceA = await create('service-items', { code: 'RS-SA', name: '合成紀錄服務甲', minutes: 60, unitPriceCents: 12345 });
  const serviceB = await create('service-items', { code: 'RS-SB', name: '合成紀錄服務乙', minutes: 30, unitPriceCents: 2222 });
  const inactive = await create('service-items', { code: 'RS-INACTIVE', name: '合成停用服務', minutes: 30, unitPriceCents: 0, status: 'inactive' });
  const outside = await create('service-items', { code: 'RS-OUTSIDE', name: '合成班次外服務', minutes: 30, unitPriceCents: 1 });
  const services = [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 2 }];
  const planData = (caseId, extra = {}) => ({ caseId, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active',
    services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 1 }], ...extra });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = extra => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-09',
    startTime: '09:00', endTime: '10:00', services: structuredClone(services), status: 'scheduled', note: '合成班次原交班', ...extra });
  const shift = await create('shifts', shiftData());
  const recordData = (item = shift, extra = {}) => ({ shiftId: item.id, caseId: item.caseId, employeeId: item.employeeId, date: item.date,
    actualStart: '09:05', actualEnd: '09:52', services: structuredClone(services), status: 'draft', note: ' 原觀察\n合成末行 ', ...extra });
  let nextDay = 0;
  const newShift = async (extra = {}) => create('shifts', shiftData({ date: new Date(Date.UTC(2026, 10, ++nextDay)).toISOString().slice(0, 10), ...extra }));
  async function imported(extra = {}, missing = [], shiftExtra = {}) {
    const parent = await newShift(shiftExtra), data = recordData(parent, extra);
    for (const key of missing) delete data[key];
    // INSERT-only synthetic migration data distinguishes preservation from normal API acceptance.
    return { item: insert(app.db, admin.org, 'service-records', data), shift: parent };
  }
  const editor = (existing, parent = shift, items = [serviceA, serviceB, inactive, outside]) => createServiceRecordEditor({ existing, shift: parent, serviceItems: items });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() });
  const certification = await create('employee-certifications', { employeeId: employeeA.id, name: '合成紀錄驗證證照', issuedOn: '2026-01-01' });
  const attachment = await create('case-attachments/upload', { caseId: caseA.id, title: '合成紀錄非空PDF', ...filePayload(PDF_BYTES) });
  const certificationAttachment = await create('certification-attachments/upload', { certificationId: certification.id, title: '合成紀錄非空PNG', ...filePayload(PNG_BYTES, '合成紀錄.png', 'image/png') });
  const baseline = state();
  assert.equal(Object.keys(baseline.tables).length, 11); assert.equal(baseline.triggers.length, 6);
  assert.equal(baseline.tables.attachment_files.length, 1); assert.equal(baseline.tables.certification_attachment_files.length, 1);
  assert.deepEqual(Buffer.from(baseline.tables.attachment_files[0].content), PDF_BYTES);
  assert.deepEqual(Buffer.from(baseline.tables.certification_attachment_files[0].content), PNG_BYTES);
  async function blobs() {
    for (const [url, bytes] of [[`/api/case-attachments/${attachment.id}/download`, PDF_BYTES], [`/api/certification-attachments/${certificationAttachment.id}/download`, PNG_BYTES]]) {
      for (const suffix of ['', '?recordVersion=1']) { const result = await request(admin, 'GET', url + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.equal(sha(result.bytes), sha(bytes)); }
    }
  }
  function relatedUnchanged(before, allowedIds) {
    const after = state(), allowed = new Set(allowedIds);
    assert.deepEqual(after.tables.records.filter(row => !allowed.has(row.id)), before.tables.records.filter(row => !allowed.has(row.id)));
    for (const table of tables.filter(name => !['records', 'record_versions', 'audit', 'idempotency'].includes(name))) assert.deepEqual(after.tables[table], before.tables[table], table);
    assert.deepEqual(after.triggers, before.triggers);
  }
  return { app, base, request, create, patch, get, review, admin, clients, employeeA, employeeB, caseA, caseB, serviceA, serviceB,
    inactive, outside, services, planA, planB, planData, shiftData, shift, recordData, newShift, imported, editor, state, blobs, relatedUnchanged };
}

test('five original controls create nine saved fields and sparse real edits preserve all ten fields and precise actors', async t => {
  const f = await fixture(t), e = f.editor();
  assert.deepEqual(e.fields.filter(field => !field.name.endsWith('Intent')).map(field => field.name), ['spanMode', 'plannedSpan', ...controls.slice(0, 2), 'actualEndDate', ...controls.slice(2)]); assert.equal(e.fields.find(field => field.name === 'plannedSpan').disabled, true);
  const payload = e.buildPayload({ actualStart: '08:01', actualEnd: '10:52', services: [{ serviceItemId: f.serviceA.id, quantity: 10000 }], note: ' 原服務觀察\n合成末行 ', status: 'draft' });
  assert.deepEqual(Object.keys(payload).sort(), keys.filter(key => key !== 'reviewNote').sort()); assert(!Object.hasOwn(payload, 'spanMode')); assert(!Object.hasOwn(payload, 'actualEndDate')); assert(!Object.hasOwn(payload, 'plannedSpan'));
  assert.equal(payload.shiftId, f.shift.id); assert.equal(payload.caseId, f.caseA.id); assert.equal(payload.employeeId, f.employeeA.id); assert.equal(payload.date, f.shift.date);
  const before = f.state(), item = await f.create('service-records', payload, f.clients.caregiver); e.confirm(item, f.admin.org, payload);
  assert.equal(f.state().changes - before.changes, 3); f.relatedUnchanged(before, [item.id]);
  assert(!Object.hasOwn(item, 'reviewNote'));
  const ed = f.editor(item), change = ed.buildPayload({ note: ' 新服務觀察\n合成保存原文 ' }); assert.deepEqual(change, { note: ' 新服務觀察\n合成保存原文 ' });
  const saved = await f.patch('service-records', item, change, f.clients.supervisor); ed.confirm(saved, f.admin.org, change);
  assert.deepEqual(projection(saved), { ...projection(item), note: change.note });
  const bound = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.caregiver]) {
    const h = await f.request(client, 'GET', history(saved)); assert.equal(h.status, 200); assert.deepEqual(h.body.items.map(row => row.version), [2, 1]);
    assert.equal(h.body.items[0].actor.id, f.clients.supervisor.user.id); assert.equal(h.body.items[1].actor.id, f.clients.caregiver.user.id);
    assert.deepEqual(h.body.items[0].comparison.previousSnapshot, h.body.items[1].snapshot);
  }
  await f.blobs(); assert.deepEqual(f.state(), bound);
});

test('sparse missing null typed and CR observations preserve own presence until explicit replacement or clearing', async t => {
  const f = await fixture(t);
  for (const source of [{ missing: true }, { note: null }, { note: 42 }, { note: { unsafe_source: '合成不投影物件' } }, { note: ['合成不投影清單'] }, { note: ' 原\r\n合成觀察 ' }]) {
    const imported = await f.imported({ ...(source.missing ? {} : { note: source.note }), reviewNote: null }, source.missing ? ['note'] : []);
    const item = imported.item, e = f.editor(item, imported.shift);
    assert.equal(e.needsIntent('note'), true); assert.equal(e.initial.note, ''); assert.equal(e.initial.noteIntent, 'keep');
    const keep = e.buildPayload({ actualEnd: '10:01' }); assert.deepEqual(keep, { actualEnd: '10:01' });
    const before = f.state(), saved = await f.patch('service-records', item, keep, f.clients.caregiver); e.confirm(saved, f.admin.org, keep);
    assert.equal(Object.hasOwn(saved, 'note'), Object.hasOwn(item, 'note')); if (Object.hasOwn(item, 'note')) assert.deepEqual(saved.note, item.note);
    assert.equal(saved.reviewNote, null); f.relatedUnchanged(before, [item.id]);
    const clearEditor = f.editor(saved, imported.shift), clear = clearEditor.buildPayload({ noteIntent: 'clear' }); assert.deepEqual(clear, { note: '' });
    const cleared = await f.patch('service-records', saved, clear); clearEditor.confirm(cleared, f.admin.org, clear); assert.equal(cleared.note, ''); assert.equal(cleared.reviewNote, null);
  }
  const absent = await f.imported({}, ['note', 'reviewNote']), e = f.editor(absent.item, absent.shift), payload = e.buildPayload({ actualEnd: '10:02' });
  const saved = await f.patch('service-records', absent.item, payload); e.confirm(saved, f.admin.org, payload);
  assert(!Object.hasOwn(saved, 'note')); assert(!Object.hasOwn(saved, 'reviewNote'));
  const before = f.state(); await f.blobs(); assert.deepEqual(f.state(), before);
});

test('saved ISO and year-zero dates survive real edits while malformed required times need explicit repair', async t => {
  const f = await fixture(t), imported = await f.imported();
  const iso = await f.patch('service-records', imported.item, { actualStart: imported.shift.date + 'T08:00:59+14:00', actualEnd: imported.shift.date + 'T08:47:01-12:00' });
  const e = f.editor(iso, imported.shift); assert.equal(e.initial.actualStart, ''); assert.equal(e.initial.actualEnd, '');
  assert.equal(e.needsIntent('actualStart'), true); assert.equal(e.needsIntent('actualEnd'), true);
  const change = e.buildPayload({ note: ' 合成只改觀察\n保留完整ISO ' }), saved = await f.patch('service-records', iso, change); e.confirm(saved, f.admin.org, change);
  assert.equal(saved.actualStart, iso.actualStart); assert.equal(saved.actualEnd, iso.actualEnd);
  const zeroPlan = await f.create('care-plans', f.planData(f.caseA.id, { validFrom: '0000-01-01', validTo: '0000-12-31' }));
  const zeroShift = await f.newShift({ carePlanId: zeroPlan.id, date: '0000-02-29' }), create = f.editor(undefined, zeroShift);
  const payload = create.buildPayload({ actualStart: '08:00', actualEnd: '08:47', services: f.services, note: '', status: 'draft' });
  const zero = await f.create('service-records', payload); create.confirm(zero, f.admin.org, payload); assert.equal(zero.date, '0000-02-29');
  const zeroEdit = f.editor(zero, zeroShift), zeroChange = zeroEdit.buildPayload({ note: '合成年零原日期保持' });
  const zeroSaved = await f.patch('service-records', zero, zeroChange); zeroEdit.confirm(zeroSaved, f.admin.org, zeroChange); assert.equal(zeroSaved.date, zero.date);
  for (const spec of [{ missing: true }, { actualStart: null }, { actualStart: { unsafe_source: true } }, { actualStart: '09:\r05' }]) {
    const legacy = await f.imported(spec.missing ? {} : { actualStart: spec.actualStart }, spec.missing ? ['actualStart'] : []), adapter = f.editor(legacy.item, legacy.shift);
    const keep = adapter.buildPayload({ note: '合成保持必要欄仍經原驗證' }); assert(!Object.hasOwn(keep, 'actualStart'));
    const before = f.state(), denied = await f.request(f.admin, 'PATCH', route(legacy.item), { version: 1, ...keep }); assert.equal(denied.status, 422); assert.deepEqual(f.state(), before);
    const repair = adapter.buildPayload({ actualStartIntent: 'replace', actualStart: '08:15' });
    const fixed = await f.patch('service-records', legacy.item, repair); adapter.confirm(fixed, f.admin.org, repair); assert.equal(fixed.actualStart, '08:15');
  }
});

test('whole services remain private in keep mode and only an explicit replacement repairs incompatible imported JSON', async t => {
  const f = await fixture(t);
  for (const [services, accepted] of [[f.services.toReversed(), true], [[{ serviceItemId: f.serviceA.id, quantity: 3, unsafe_source: '合成額外鍵' }], false],
    [[f.services[0], f.services[0]], false], [[{ serviceItemId: id(), quantity: 1 }], false], [[{ serviceItemId: f.serviceA.id, quantity: '3' }], false]]) {
    const legacy = await f.imported({ services }), e = f.editor(legacy.item, legacy.shift, []);
    assert.equal(e.needsIntent('services'), true); assert.equal(e.enabled('services'), false); assert.deepEqual(e.initial.services, []);
    const keep = e.buildPayload({ note: '合成整欄保持' }); assert(!Object.hasOwn(keep, 'services'));
    const before = f.state(), response = await f.request(f.admin, 'PATCH', route(legacy.item), { version: 1, ...keep });
    if (accepted) { assert.equal(response.status, 200); e.confirm(response.body.item, f.admin.org, keep); assert.deepEqual(response.body.item.services, services); }
    else { assert.equal(response.status, 422); assert.deepEqual(f.state(), before); }
    const current = await f.get('service-records', legacy.item), replace = f.editor(current, legacy.shift), payload = replace.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: f.serviceB.id, quantity: 10000 }] });
    const saved = await f.patch('service-records', current, payload); replace.confirm(saved, f.admin.org, payload); assert.deepEqual(saved.services, payload.services);
    assert(!Object.hasOwn(payload, 'shiftId')); assert(!Object.hasOwn(payload, 'caseId')); assert(!Object.hasOwn(payload, 'employeeId')); assert(!Object.hasOwn(payload, 'date'));
  }
});

test('original same-day time and service boundaries reject writes atomically without inventing scheduled-time or quantity quotas', async t => {
  const f = await fixture(t), item = await f.create('service-records', f.recordData(), f.clients.caregiver);
  const bad = [{ actualStart: '24:00' }, { actualEnd: '09:05' }, { actualEnd: '09:04' }, { actualStart: '2026-10-10T09:05:00Z' }, { date: '2026-02-30' },
    { services: [] }, { services: null }, { services: [{ serviceItemId: f.serviceA.id, quantity: 0 }] }, { services: [{ serviceItemId: f.serviceA.id, quantity: 10001 }] },
    { services: [{ serviceItemId: f.serviceA.id, quantity: 1.5 }] }, { services: [{ serviceItemId: f.serviceA.id, quantity: '1' }] },
    { services: [{ serviceItemId: f.serviceA.id, quantity: 1, extra: true }] }, { services: [f.services[0], f.services[0]] },
    { services: Array.from({ length: 101 }, () => f.services[0]) }, { services: [{ serviceItemId: f.inactive.id, quantity: 1 }] },
    { services: [{ serviceItemId: f.outside.id, quantity: 1 }] }, { services: [{ serviceItemId: id(), quantity: 1 }] },
    { note: null }, { note: '字'.repeat(10001) }, { unknown: true }, { billingSnapshot: {} }, { status: 'approved' }, { status: 'returned' }, { reviewNote: '' }];
  const before = f.state();
  for (const change of bad) { const response = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...change }); assert.equal(response.status, 422, JSON.stringify(change)); assert.deepEqual(f.state(), before); }
  const e = f.editor(item), payload = e.buildPayload({ actualStart: '08:00', actualEnd: '12:00', servicesIntent: 'replace', services: [{ serviceItemId: f.serviceA.id, quantity: 10000 }], note: '🙂'.repeat(5000) });
  const saved = await f.patch('service-records', item, payload, f.clients.caregiver); e.confirm(saved, f.admin.org, payload);
  assert.equal(saved.note.length, 10000); assert.equal(saved.services[0].quantity, 10000); assert.equal(saved.actualStart, '08:00'); assert.equal(saved.actualEnd, '12:00');
  assert.equal(f.shift.startTime, '09:00'); assert.equal(f.planA.services[0].quantity, 1); assert.deepEqual(await f.get('shifts', f.shift), f.shift);
});

test('returned editing preserves returned status and review text until explicit draft or resubmission with exact lifecycle actors', async t => {
  const f = await fixture(t); let item = await f.create('service-records', f.recordData(), f.clients.caregiver);
  let e = f.editor(item), payload = e.buildPayload({ status: 'submitted' }); item = await f.patch('service-records', item, payload, f.clients.caregiver); e.confirm(item, f.admin.org, payload);
  let review = createServiceRecordReview({ existing: item }); assert.equal(review.initial.decision, 'approved'); assert.equal(review.initial.reviewNote, '');
  assert.throws(() => review.buildPayload({ decision: 'returned', reviewNote: ' \n\t ' }));
  payload = review.buildPayload({ decision: 'returned', reviewNote: ' \n合成退回需補觀察\n ' }); item = await f.review(item, payload); review.confirm(item, f.admin.org, payload);
  assert.equal(item.status, 'returned'); assert.equal(item.reviewNote, payload.reviewNote);
  e = f.editor(item); assert.equal(e.initial.status, 'returned'); payload = e.buildPayload({ note: '合成只保存退回修改' }); assert.deepEqual(payload, { note: '合成只保存退回修改' });
  item = await f.patch('service-records', item, payload, f.clients.caregiver); e.confirm(item, f.admin.org, payload); assert.equal(item.status, 'returned');
  assert.deepEqual(await f.get('shifts', f.shift), f.shift);
  e = f.editor(item); payload = e.buildPayload({ status: 'draft' }); item = await f.patch('service-records', item, payload, f.clients.caregiver); e.confirm(item, f.admin.org, payload);
  e = f.editor(item); payload = e.buildPayload({ status: 'submitted', actualEnd: '10:01' }); item = await f.patch('service-records', item, payload, f.clients.caregiver); e.confirm(item, f.admin.org, payload);
  assert.equal(item.reviewNote, ' \n合成退回需補觀察\n ');
  review = createServiceRecordReview({ existing: item }); payload = review.buildPayload({ decision: 'approved', reviewNote: ' 合成核閱保存原文\n ' });
  item = await f.review(item, payload, f.admin); review.confirm(item, f.admin.org, payload);
  const completed = await f.get('shifts', f.shift); assert.equal(completed.status, 'completed'); assert.equal(completed.version, 2);
  const before = f.state(), h = await f.request(f.admin, 'GET', history(item)); assert.equal(h.status, 200);
  assert.deepEqual(h.body.items.map(row => row.snapshot.status), ['approved', 'submitted', 'draft', 'returned', 'returned', 'submitted', 'draft']);
  assert.deepEqual(h.body.items.map(row => row.actor.id), [f.admin, f.clients.caregiver, f.clients.caregiver, f.clients.caregiver, f.clients.supervisor, f.clients.caregiver, f.clients.caregiver].map(client => client.user.id));
  const shiftHistory = await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id + '/history?compare=previous'); assert.equal(shiftHistory.body.items[0].actor.id, f.admin.user.id);
  await f.blobs(); assert.deepEqual(f.state(), before);
});

test('real create return and approval replays keep their original response and write counts under the same idempotency key', async t => {
  const f = await fixture(t), e = f.editor(), payload = e.buildPayload({ actualStart: '09:05', actualEnd: '09:52', services: f.services, note: '合成冪等草稿', status: 'submitted' });
  const createHeaders = { 'Idempotency-Key': 'synthetic-record-create-once' }, before = f.state();
  const first = await f.request(f.admin, 'POST', '/api/service-records', payload, createHeaders); assert.equal(first.status, 201); e.confirm(first.body.item, f.admin.org, payload);
  assert.equal(f.state().changes - before.changes, 4); const committed = f.state();
  assert.deepEqual((await f.request(f.admin, 'POST', '/api/service-records', payload, createHeaders)).body, first.body); assert.deepEqual(f.state(), committed);
  assert.equal((await f.request(f.admin, 'POST', '/api/service-records', { ...payload, note: '另一合成內容' }, createHeaders)).status, 409);
  assert.equal((await f.request(f.admin, 'POST', '/api/announcements', { title: '合成不同路由', body: '不得寫入' }, createHeaders)).status, 409); assert.deepEqual(f.state(), committed);
  let item = first.body.item, r = createServiceRecordReview({ existing: item }), change = r.buildPayload({ decision: 'returned', reviewNote: ' 合成退回\n原文 ' });
  const returnHeaders = { 'Idempotency-Key': 'synthetic-record-return-once' }, returned = await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change }, returnHeaders);
  assert.equal(returned.status, 200); r.confirm(returned.body.item, f.admin.org, change); assert.equal(f.state().changes - committed.changes, 4); const returnedState = f.state();
  assert.deepEqual((await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change }, returnHeaders)).body, returned.body);
  assert.equal((await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change, reviewNote: '合成不同退回原因' }, returnHeaders)).status, 409); assert.deepEqual(f.state(), returnedState);
  item = returned.body.item; const editor = f.editor(item), submit = editor.buildPayload({ status: 'submitted' }); item = await f.patch('service-records', item, submit); editor.confirm(item, f.admin.org, submit);
  r = createServiceRecordReview({ existing: item }); change = r.buildPayload({ decision: 'approved', reviewNote: '' });
  const approvalHeaders = { 'Idempotency-Key': 'synthetic-record-approve-once' }, preApproval = f.state();
  const approved = await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change }, approvalHeaders); assert.equal(approved.status, 200); r.confirm(approved.body.item, f.admin.org, change);
  assert.equal(f.state().changes - preApproval.changes, 7); const stable = f.state();
  assert.deepEqual((await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change }, approvalHeaders)).body, approved.body);
  const stale = await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...change }, { 'Idempotency-Key': 'synthetic-record-new-stale-key' }); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(f.state(), stable); assert.equal(stable.tables.idempotency.length, 3); assert.equal((await f.get('shifts', f.shift)).version, 2);
});

test('server membership four-role Origin CSRF CAS and submitted or approved locks reject writes without changing eleven tables', async t => {
  const f = await fixture(t), item = await f.create('service-records', f.recordData(), f.clients.caregiver);
  const foreignOrg = await f.create('organizations', { name: '合成紀錄隔離乙機構' }), foreign = { ...f.admin, org: foreignOrg.id }, before = f.state();
  for (const client of [f.clients.finance, f.clients.caregiverB]) {
    assert.equal((await f.request(client, 'POST', '/api/service-records', f.recordData())).status, 403);
    assert.equal((await f.request(client, 'PATCH', route(item), { version: 1, note: '合成無權寫入' })).status, 403);
    assert.equal((await f.request(client, 'POST', route(item) + '/review', { version: 1, decision: 'approved' })).status, 403);
  }
  assert.equal((await f.request(f.clients.caregiver, 'POST', route(item) + '/review', { version: 1, decision: 'approved' })).status, 403);
  for (const url of [route(item), history(item)]) { assert.equal((await f.request(null, 'GET', url)).status, 401); assert.equal((await f.request(f.clients.caregiverB, 'GET', url)).status, 404); assert.equal((await f.request(foreign, 'GET', url)).status, 404); }
  assert.equal((await f.request(foreign, 'PATCH', route(item), { version: 1, note: '合成跨機構' })).status, 404);
  for (const token of ['', 'wrong']) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '合成CSRF拒絕' }, { 'X-CSRF-Token': token })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '合成Origin拒絕' }, { Origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '合成membership拒絕' }, { 'X-Org-Id': id() })).status, 403);
  for (const version of [undefined, 0, -1, '1', 1.5]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version, note: '合成版本拒絕' })).status, 422);
  assert.deepEqual(f.state(), before);
  const e = f.editor(item), change = e.buildPayload({ note: '督導合成新版本' }), updated = await f.patch('service-records', item, change, f.clients.supervisor); e.confirm(updated, f.admin.org, change);
  const changed = f.state(), stale = await f.request(f.clients.caregiver, 'PATCH', route(item), { version: 1, note: '我的合成舊輸入' }); assert.equal(stale.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(f.state(), changed);
  let current = await f.patch('service-records', updated, { status: 'submitted' }, f.clients.caregiver);
  for (const status of ['submitted', 'approved']) {
    const stable = f.state();
    for (const client of [f.admin, f.clients.supervisor, f.clients.caregiver]) { const denied = await f.request(client, 'PATCH', route(current), { version: current.version, note: '不可改鎖定紀錄' }); assert.equal(denied.body.error.code, 'RECORD_LOCKED'); }
    assert.deepEqual(f.state(), stable);
    if (status === 'submitted') current = await f.review(current, { decision: 'approved', reviewNote: '合成核閱' }, f.admin);
  }
});

test('approval captures current prices and rates once while all role projections and later master edits preserve the snapshot', async t => {
  const f = await fixture(t), item = await f.create('service-records', f.recordData(f.shift, { status: 'submitted' }), f.clients.caregiver);
  const r = createServiceRecordReview({ existing: item }), payload = r.buildPayload({ decision: 'approved', reviewNote: ' 合成價格核閱\n ' }), before = f.state();
  const supervisorResult = await f.review(item, payload, f.clients.supervisor); r.confirm(supervisorResult, f.admin.org, payload); assert(!Object.hasOwn(supervisorResult, 'billingSnapshot'));
  f.relatedUnchanged(before, [item.id, f.shift.id]);
  const approved = await f.get('service-records', item), completed = await f.get('shifts', f.shift);
  assert.equal(approved.billingSnapshot.currency, 'TWD'); assert.equal(approved.billingSnapshot.trial, true); assert.equal(approved.billingSnapshot.source, 'approval');
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000);
  assert.deepEqual(approved.billingSnapshot.items.map(entry => [entry.quantity, entry.unitPriceCents, entry.amountCents]), [[3, 12345, 37035], [2, 2222, 4444]]);
  assert.equal(completed.status, 'completed');
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 41479); assert.equal(payroll.totals.amountCents, 18800);
  await f.patch('service-items', f.serviceA, { unitPriceCents: 99999, name: '合成目前服務新名稱' }); await f.patch('employees', f.employeeA, { hourlyRateCents: 88888, name: '合成目前員工新名稱' });
  const stable = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.caregiver]) {
    const financial = client === f.admin || client === f.clients.finance;
    for (const url of [route(item), '/api/service-records', history(item, false), history(item), '/api/dashboard?date=2026-10-09']) {
      const response = await f.request(client, 'GET', url); assert.equal(response.status, 200);
      if (!financial) assert(!JSON.stringify(response.body).includes('billingSnapshot'));
      if (url === route(item)) assert.equal(Object.hasOwn(response.body.item, 'billingSnapshot'), financial);
      if (url === history(item)) for (const row of response.body.items) for (const snapshot of [row.snapshot, row.comparison.previousSnapshot].filter(Boolean)) {
        assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), financial && snapshot.status === 'approved');
      }
    }
  }
  assert.deepEqual(await f.get('service-records', approved), approved); assert.deepEqual(await f.get('shifts', completed), completed);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees); assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  await f.blobs(); assert.deepEqual(f.state(), stable);
});

test('existing draft reassignment remains legal through another valid employee or case and historical scope never skips predecessors', async t => {
  const f = await fixture(t); let item = await f.create('service-records', f.recordData(), f.clients.caregiver);
  const shiftB = await f.newShift({ employeeId: f.employeeB.id }), moved = await f.patch('service-records', item, { shiftId: shiftB.id, employeeId: f.employeeB.id, date: shiftB.date, actualStart: '11:05', actualEnd: '11:52' }, f.clients.supervisor);
  assert.equal((await f.request(f.clients.caregiver, 'GET', route(moved))).status, 404); assert.equal((await f.request(f.clients.caregiverB, 'GET', route(moved))).status, 200);
  item = await f.patch('service-records', moved, { shiftId: f.shift.id, employeeId: f.employeeA.id, date: f.shift.date, actualStart: '09:05', actualEnd: '09:52' });
  const own = await f.request(f.clients.caregiver, 'GET', history(item)); assert.deepEqual(own.body.items.map(row => row.version), [3, 1]); assert.equal(own.body.items[0].comparison.status, 'unavailable');
  const caseShift = await f.newShift({ caseId: f.caseB.id, carePlanId: f.planB.id });
  item = await f.patch('service-records', item, { shiftId: caseShift.id, caseId: f.caseB.id, date: caseShift.date }, f.clients.caregiver);
  await f.patch('shifts', f.shift, { employeeId: f.employeeB.id });
  const before = f.state(), hidden = await f.request(f.clients.caregiver, 'GET', history(item)); assert.deepEqual(hidden.body.items.map(row => row.version), [4]); assert.equal(hidden.body.items[0].comparison.status, 'unavailable');
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) assert.deepEqual((await f.request(client, 'GET', history(item))).body.items.map(row => row.version), [4, 3, 2, 1]);
  const bad = await f.request(f.admin, 'PATCH', route(item), { version: item.version, caseId: f.caseA.id }); assert.equal(bad.body.error.code, 'SHIFT_MISMATCH'); assert.deepEqual(f.state(), before);
  await f.newShift({ date: '2026-01-01', status: 'cancelled' });
  const restored = f.state(), visible = await f.request(f.clients.caregiver, 'GET', history(item)); assert.deepEqual(visible.body.items.map(row => row.version), [4, 3, 1]);
  assert.equal(visible.body.items[0].comparison.previousVersion, 3); assert.equal(visible.body.items[1].comparison.status, 'unavailable'); assert.deepEqual(f.state(), restored);
  const e = f.editor(item, caseShift), sparse = e.buildPayload({ note: '合成當前四關聯保持' }); assert.deepEqual(sparse, { note: '合成當前四關聯保持' });
});

test('submission and review revalidate current references and leave failed idempotency claims and inherited billing untouched', async t => {
  const f = await fixture(t), imported = await f.imported({ billingSnapshot: { unsafe_source: '合成匯入舊快照', serviceMinutes: 99 }, reviewNote: { unsafe_source: '合成匯入核閱內文' } });
  const e = f.editor(imported.item, imported.shift), payload = e.buildPayload({ note: '合成只改觀察保留內部欄' }), saved = await f.patch('service-records', imported.item, payload); e.confirm(saved, f.admin.org, payload);
  assert.deepEqual(saved.billingSnapshot, imported.item.billingSnapshot); assert.deepEqual(saved.reviewNote, imported.item.reviewNote);
  const submitted = await f.patch('service-records', saved, { status: 'submitted' }, f.clients.caregiver);
  const draftShift = await f.newShift(), draft = await f.create('service-records', f.recordData(draftShift), f.clients.caregiver);
  const draftEditor = f.editor(draft, draftShift), submitPayload = draftEditor.buildPayload({ status: 'submitted' });
  let service = await f.patch('service-items', f.serviceA, { status: 'inactive' });
  let before = f.state();
  const blockedSubmit = await f.request(f.clients.caregiver, 'PATCH', route(draft), { version: draft.version, ...submitPayload });
  assert.equal(blockedSubmit.body.error.code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  for (const decision of ['returned', 'approved']) {
    const response = await f.request(f.clients.supervisor, 'POST', route(submitted) + '/review', { version: submitted.version, decision, reviewNote: '合成原驗證拒絕' }, { 'Idempotency-Key': 'synthetic-current-service-' + decision });
    assert.equal(response.status, 422); assert.equal(response.body.error.code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  }
  assert.deepEqual((await f.get('service-records', submitted)).billingSnapshot, imported.item.billingSnapshot); assert.equal((await f.get('shifts', imported.shift)).status, 'scheduled');
  service = await f.patch('service-items', service, { status: 'active', unitPriceCents: 23456 });
  const employee = await f.patch('employees', f.employeeA, { status: 'inactive' }); before = f.state();
  const inactive = await f.request(f.clients.supervisor, 'POST', route(submitted) + '/review', { version: submitted.version, decision: 'approved' }); assert.equal(inactive.body.error.code, 'INACTIVE_ASSIGNMENT');
  assert.equal((await f.request(f.clients.caregiver, 'GET', route(submitted))).status, 403); assert.deepEqual(f.state(), before);
  await f.patch('employees', employee, { status: 'active' });
  const r = createServiceRecordReview({ existing: await f.get('service-records', submitted) }), change = r.buildPayload({ decision: 'approved', reviewNote: '合成有效規則恢復後核閱' });
  const approved = await f.review(submitted, change, f.admin); r.confirm(approved, f.admin.org, change);
  assert.equal(approved.billingSnapshot.items[0].unitPriceCents, service.unitPriceCents); assert(!Object.hasOwn(approved.billingSnapshot, 'unsafe_source'));
  assert.equal(approved.reviewNote, change.reviewNote); assert.equal((await f.get('shifts', imported.shift)).status, 'completed');
});

test('completion failure rolls back approval and its key then successful receipts and read-only files histories reports preserve immutable storage', async t => {
  const f = await fixture(t), item = await f.create('service-records', f.recordData(f.shift, { status: 'submitted' }), f.clients.caregiver);
  const r = createServiceRecordReview({ existing: item }), payload = r.buildPayload({ decision: 'approved', reviewNote: '合成完整交易驗證' }), before = f.state();
  // A TEMP fixture trigger aborts after the record UPDATE and version INSERT, before shift completion.
  f.app.db.exec(`CREATE TEMP TRIGGER synthetic_service_completion_fail BEFORE UPDATE ON records WHEN OLD.id='${f.shift.id}' BEGIN SELECT RAISE(ABORT,'Synthetic completion failure'); END;`);
  const failed = await f.request(f.admin, 'POST', route(item) + '/review', { version: item.version, ...payload }, { 'Idempotency-Key': 'synthetic-atomic-approval' }); assert.equal(failed.status, 500);
  f.app.db.exec('DROP TRIGGER synthetic_service_completion_fail');
  const rolledBack = f.state(); assert.deepEqual(rolledBack.tables, before.tables); assert.deepEqual(rolledBack.triggers, before.triggers);
  // SQLite total_changes includes the two attempted writes even though both were rolled back.
  assert.equal(rolledBack.changes - before.changes, 2); assert.equal(rolledBack.tables.idempotency.length, 0);
  const approved = await f.review(item, payload, f.admin, { 'Idempotency-Key': 'synthetic-atomic-approval' }); r.confirm(approved, f.admin.org, payload);
  const stable = f.state(); assert.equal(stable.changes - rolledBack.changes, 7); assert.equal(stable.triggers.length, 6);
  for (const key of keys) {
    if (Object.hasOwn(approved, key)) { const missing = { ...approved }; delete missing[key]; assert.throws(() => r.confirm(missing, f.admin.org, payload), saveUnconfirmed); }
    const wrong = { ...approved, [key]: key === 'services' ? [] : '合成錯誤保存投影' }; assert.throws(() => r.confirm(wrong, f.admin.org, payload), saveUnconfirmed);
  }
  for (const response of [null, {}, Object.create(approved), { ...approved, id: id() }, { ...approved, orgId: id() }, { ...approved, version: '2' }, { ...approved, version: 3 }]) assert.throws(() => r.confirm(response, f.admin.org, payload), saveUnconfirmed);
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.caregiver]) {
    for (const url of [route(approved), history(approved), history(approved, false), '/api/service-report?startDate=2026-10-01&endDate=2026-10-31', '/api/service-report/export?startDate=2026-10-01&endDate=2026-10-31', '/api/service-report.csv?startDate=2026-10-01&endDate=2026-10-31']) {
      assert.equal((await f.request(client, 'GET', url)).status, 200);
    }
  }
  for (const client of [f.admin, f.clients.finance]) for (const kind of ['fees', 'payroll']) assert.equal((await f.request(client, 'GET', '/api/reports/' + kind + '?month=2026-10')).status, 200);
  await f.blobs(); assert.deepEqual(f.state(), stable);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    assert.throws(() => f.app.db.exec('DELETE FROM ' + table), /immutable/);
    assert.throws(() => f.app.db.exec('UPDATE ' + table + ' SET ' + (table === 'record_versions' ? 'version=version' : 'id=id')), /immutable/);
  }
  assert.deepEqual(f.state(), stable);
});
