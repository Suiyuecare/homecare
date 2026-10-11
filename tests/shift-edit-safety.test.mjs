import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';
import { createShiftEditor } from '../public/data/shift-editor.js';

const keys = ['caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note'];
const controls = ['carePlanId', 'employeeId', 'date', 'startTime', 'endTime', 'services', 'note'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const password = 'synthetic-shift-edit-safety-password';
const route = item => '/api/shifts/' + item.id;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const projection = item => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extra = {}, raw) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成班次管理者', email: 'admin@shift-editor.example.test', password, organizationName: '合成班次甲機構' });
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
  const employeeA = await create('employees', { name: '合成居服甲', employeeNo: 'SE-A', role: 'caregiver', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成居服乙', employeeNo: 'SE-B', role: 'caregiver', hourlyRateCents: 26000 });
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA], ['caregiverB', 'caregiver', employeeB]]) {
    const email = key + '@shift-editor.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = from(login);
  }
  const caseA = await create('cases', { name: '合成班次個案甲', caseNo: 'SE-CA' });
  const caseB = await create('cases', { name: '合成班次個案乙', caseNo: 'SE-CB' });
  const serviceA = await create('service-items', { code: 'SE-SA', name: '合成服務甲', minutes: 60, unitPriceCents: 12345 });
  const serviceB = await create('service-items', { code: 'SE-SB', name: '合成服務乙', minutes: 30, unitPriceCents: 2222 });
  const inactive = await create('service-items', { code: 'SE-OLD', name: '合成停用服務', minutes: 30, unitPriceCents: 0, status: 'inactive' });
  const services = [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 2 }];
  const planData = (caseId, extra = {}) => ({ caseId, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active',
    services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 1 }, { serviceItemId: inactive.id, quantity: 1 }], ...extra });
  const planA = await create('care-plans', planData(caseA.id)), planA2 = await create('care-plans', planData(caseA.id));
  const planB = await create('care-plans', planData(caseB.id));
  const planBOnly = await create('care-plans', planData(caseB.id, { services: [{ serviceItemId: serviceB.id, quantity: 1 }] }));
  const data = extra => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-09',
    startTime: '09:00', endTime: '10:00', services: structuredClone(services), status: 'scheduled', note: ' 原交班\n末行 ', ...extra });
  const shift = await create('shifts', data());
  const editor = (existing, extra = {}) => createShiftEditor({ existing, cases: [caseA, caseB], employees: [employeeA, employeeB],
    carePlans: [planA, planA2, planB, planBOnly], serviceItems: [serviceA, serviceB, inactive], defaultDate: '2026-10-10', ...extra });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  let importDay = 0;
  const imported = (extra = {}, missing = []) => {
    const date = new Date(Date.UTC(2026, 10, ++importDay)).toISOString().slice(0, 10), value = data({ date, ...extra });
    for (const key of missing) delete value[key];
    return insert(app.db, admin.org, 'shifts', value); // INSERT-only migration fixture, not normal API acceptance.
  };
  const get = async (kind, item, client = admin) => (await request(client, 'GET', '/api/' + kind + '/' + item.id)).body.item;
  async function record(item, status = 'draft') {
    const saved = await create('service-records', { shiftId: item.id, caseId: item.caseId, employeeId: item.employeeId, date: item.date,
      actualStart: '09:05', actualEnd: '09:52', services: structuredClone(item.services), status: status === 'returned' ? 'submitted' : status }, clients.caregiver);
    if (status !== 'returned') return saved;
    const result = await request(clients.supervisor, 'POST', '/api/service-records/' + saved.id + '/review', { version: saved.version, decision: 'returned', reviewNote: '合成退回' });
    assert.equal(result.status, 200); return get('service-records', saved);
  }
  async function approve(item = shift) {
    const saved = await record(item, 'submitted');
    const result = await request(clients.supervisor, 'POST', '/api/service-records/' + saved.id + '/review', { version: saved.version, decision: 'approved', reviewNote: '合成核閱' });
    assert.equal(result.status, 200); return get('service-records', saved);
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, caseB, serviceA, serviceB, inactive,
    services, planA, planA2, planB, planBOnly, planData, data, shift, editor, state, imported, get, record, approve };
}

test('seven original controls derive nine create fields; selective edit omits case and status and preserves text and actors', async t => {
  const f = await fixture(t), e = f.editor();
  assert.deepEqual(e.fields.filter(field => !field.name.endsWith('Intent')).map(field => field.name), ['spanMode', ...controls.slice(0, 3), 'endDate', ...controls.slice(3)]);
  const payload = e.buildPayload({ carePlanId: f.planA.id, employeeId: f.employeeA.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: f.services, note: ' 原文\n末行 ' });
  assert.deepEqual(Object.keys(payload).sort(), keys.slice().sort()); assert(!Object.hasOwn(payload, 'spanMode')); assert(!Object.hasOwn(payload, 'endDate')); assert.equal(payload.caseId, f.caseA.id); assert.equal(payload.status, 'scheduled');
  const first = await f.create('shifts', payload); e.confirm(first, f.admin.org, payload);
  const ed = f.editor(first), change = ed.buildPayload({ note: ' 新文\n末行 ' }); assert.deepEqual(change, { note: ' 新文\n末行 ' });
  const second = await f.patch('shifts', first, change, f.clients.supervisor); ed.confirm(second, f.admin.org, change);
  const unchanged = f.editor(second).buildPayload({ carePlanId: second.carePlanId, employeeId: second.employeeId, date: second.date,
    startTime: second.startTime, endTime: second.endTime, note: second.note }); assert.deepEqual(unchanged, {});
  const third = await f.patch('shifts', second, unchanged); f.editor(second).confirm(third, f.admin.org, unchanged);
  const before = f.state(), saved = (await f.request(f.admin, 'GET', history(third))).body;
  assert.equal(saved.items.length, 3); assert.equal(saved.items[1].actor.id, f.clients.supervisor.user.id);
  assert.deepEqual(projection(saved.items.at(-1).snapshot), payload); assert.deepEqual(f.state(), before);
  assert.deepEqual(f.app.db.prepare("SELECT detail FROM audit WHERE record_id=? AND action='record.update' ORDER BY rowid").all(first.id).map(row => JSON.parse(row.detail).fields), [['note'], []]);
});

test('same-case and cross-case plan selection derive case only for an actual different plan; employee changes remain legal', async t => {
  const f = await fixture(t); let item = f.shift;
  for (const [plan, employee] of [[f.planA2, f.employeeA], [f.planB, f.employeeB], [f.planA, f.employeeA]]) {
    const e = f.editor(item), payload = e.buildPayload({ carePlanId: plan.id, employeeId: employee.id });
    if (item.caseId === plan.caseId) assert(!Object.hasOwn(payload, 'caseId')); else assert.equal(payload.caseId, plan.caseId);
    assert.equal(payload.carePlanId, plan.id);
    item = await f.patch('shifts', item, payload); e.confirm(item, f.admin.org, payload);
  }
  const mismatched = f.imported({ caseId: f.caseB.id }), e = f.editor(mismatched), payload = e.buildPayload({ note: '不暗自修復個案' });
  assert.deepEqual(payload, { note: '不暗自修復個案' }); const before = f.state();
  const result = await f.request(f.admin, 'PATCH', route(mismatched), { version: 1, ...payload });
  assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_PLAN'); assert.deepEqual(f.state(), before);
});

test('whole-list service keep retains order; explicit replacement controls membership and does not create quantity quota', async t => {
  const f = await fixture(t), e = f.editor(f.shift);
  assert.deepEqual(e.initial.services, []); assert.equal(e.initial.servicesIntent, 'keep');
  assert(e.serviceOptions().some(option => option.value === f.inactive.id), 'Original choices do not filter item status');
  let item = await f.patch('shifts', f.shift, e.buildPayload({ note: '只改備註' })); assert.deepEqual(item.services, f.services);
  const x = f.editor(item); assert.deepEqual(x.buildPayload({ servicesIntent: 'replace', services: f.services }), {});
  const reverse = f.services.toReversed(), changed = x.buildPayload({ servicesIntent: 'replace', services: reverse });
  item = await f.patch('shifts', item, changed); x.confirm(item, f.admin.org, changed); assert.deepEqual(item.services, reverse);
  const large = f.editor(item).buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: f.serviceA.id, quantity: 10000 }] });
  item = await f.patch('shifts', item, large); assert.equal(item.services[0].quantity, 10000); assert.equal(f.planA.services[0].quantity, 1);
  const different = f.editor(item), keep = different.buildPayload({ carePlanId: f.planBOnly.id }); assert(!Object.hasOwn(keep, 'services'));
  const before = f.state(), refused = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...keep });
  assert.equal(refused.status, 422); assert.equal(refused.body.error.code, 'PLAN_SERVICE'); assert.deepEqual(f.state(), before);
  const repaired = different.buildPayload({ carePlanId: f.planBOnly.id, servicesIntent: 'replace', services: [{ serviceItemId: f.serviceB.id, quantity: 2 }] });
  different.confirm(await f.patch('shifts', item, repaired), f.admin.org, repaired);
});

test('API-legal ISO and year zero remain private and exact; native replacement never trims seconds or offsets implicitly', async t => {
  const f = await fixture(t), plan = await f.create('care-plans', f.planData(f.caseA.id, { validFrom: '0000-01-01', validTo: '9999-12-31' }));
  const first = await f.create('shifts', f.data({ carePlanId: plan.id, date: '0000-02-29', startTime: '0000-02-29T09:00:59+08:00', endTime: '0000-02-29T10:00:01-04:00', note: 'PRIVATE\r\n末行' }));
  const e = f.editor(first, { carePlans: [plan] }); for (const key of ['date', 'startTime', 'endTime', 'note']) { assert(e.needsIntent(key)); assert.equal(e.initial[key], ''); }
  assert(!JSON.stringify(e.fields).includes('PRIVATE')); const kept = await f.patch('shifts', first, e.buildPayload({})); e.confirm(kept, f.admin.org, {});
  assert.deepEqual(projection(kept), projection(first));
  const x = f.editor(kept, { carePlans: [plan] }), bad = x.buildPayload({ dateIntent: 'replace', date: '0001-02-28' }), before = f.state();
  const rejected = await f.request(f.admin, 'PATCH', route(kept), { version: kept.version, ...bad }); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'TIME_RANGE'); assert.deepEqual(f.state(), before);
  const replacement = x.buildPayload({ dateIntent: 'replace', date: '0001-02-28', startTimeIntent: 'replace', startTime: '09:00', endTimeIntent: 'replace', endTime: '10:00', noteIntent: 'clear' });
  x.confirm(await f.patch('shifts', kept, replacement), f.admin.org, replacement);
  const minutes = await f.request(f.admin, 'POST', '/api/shifts', f.data({ date: '2026-10-12', startTime: '2026-10-12T09:00:01+08:00', endTime: '2026-10-12T09:00:59-04:00' }));
  assert.equal(minutes.status, 422); assert.equal(minutes.body.error.code, 'TIME_RANGE');
});

test('malformed imported services stay private and merged validation rejects without writes until explicit whole repair', async t => {
  const f = await fixture(t), badValues = [null, [], 'PRIVATE', false, { secret: 'PRIVATE' }, [null],
    [{ serviceItemId: f.serviceA.id, quantity: 1, extra: { secret: 'PRIVATE' } }], [{ serviceItemId: f.serviceA.id, quantity: 1 }, { serviceItemId: f.serviceA.id, quantity: 2 }],
    [{ serviceItemId: f.serviceA.id, quantity: '2' }], [{ serviceItemId: id(), quantity: 1 }]];
  for (const services of badValues) {
    const item = f.imported({ services }), e = f.editor(item); assert.deepEqual(e.buildPayload({}), {}); assert(!JSON.stringify(e.fields).includes('PRIVATE'));
    const before = f.state(), result = await f.request(f.admin, 'PATCH', route(item), { version: 1, ...e.buildPayload({ note: '不繞過merged' }) });
    assert.equal(result.status, 422); assert.deepEqual(f.state(), before);
    const payload = e.buildPayload({ servicesIntent: 'replace', services: f.services }); e.confirm(await f.patch('shifts', item, payload), f.admin.org, payload);
  }
  const missing = f.imported({}, ['services']), before = f.state(); assert.equal((await f.request(f.admin, 'PATCH', route(missing), { version: 1 })).status, 422); assert.deepEqual(f.state(), before);
});

test('optional own absence and JSON types remain exact; invalid required dates times and references are not guessed', async t => {
  const f = await fixture(t);
  for (const note of [null, false, 0, [], JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}')]) {
    const item = f.imported({ note }), e = f.editor(item), payload = e.buildPayload({ employeeId: f.employeeB.id }), kept = await f.patch('shifts', item, payload);
    e.confirm(kept, f.admin.org, payload); assert.deepEqual(kept.note, note); const clear = f.editor(kept); clear.confirm(await f.patch('shifts', kept, clear.buildPayload({ noteIntent: 'clear' })), f.admin.org, { note: '' });
  }
  const absent = f.imported({}, ['note']), kept = await f.patch('shifts', absent, f.editor(absent).buildPayload({ employeeId: f.employeeB.id })); assert(!Object.hasOwn(kept, 'note'));
  for (const [key, value] of [['date', '2026-02-30'], ['date', null], ['date', { unsafe_source: 'PRIVATE' }], ['startTime', '24:00'], ['endTime', {}], ['employeeId', {}], ['carePlanId', id()]]) {
    const item = f.imported({ [key]: value }), e = f.editor(item); assert(e.needsIntent(key)); const before = f.state();
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, ...e.buildPayload({ note: '不改壞required' }) })).status, 422); assert.deepEqual(f.state(), before);
  }
  assert.equal({}.secret, undefined);
});

test('original merged active assignment plan validity service status and foreign references remain server constraints', async t => {
  const f = await fixture(t), item = f.shift, before = f.state();
  for (const payload of [{ services: [{ serviceItemId: f.inactive.id, quantity: 1 }] }, { date: '2028-01-01' }, { caseId: f.caseB.id }, { employeeId: id() }, { carePlanId: id() }]) {
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, ...payload })).status, 422); assert.deepEqual(f.state(), before);
  }
  const org = await f.create('organizations', { name: '合成外機構' }), other = { ...f.admin, org: org.id };
  const foreign = await f.create('employees', { name: '合成外員工', employeeNo: 'SE-FOREIGN' }, other), bound = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, employeeId: foreign.id })).status, 422); assert.deepEqual(f.state(), bound);
  const inactiveEmployee = await f.patch('employees', f.employeeB, { status: 'inactive' }), input = f.editor(f.imported({ employeeId: inactiveEmployee.id }), { employees: [f.employeeA, inactiveEmployee] });
  assert.equal(input.initial.employeeId, inactiveEmployee.id); assert(!f.editor(undefined, { employees: [f.employeeA, inactiveEmployee] }).fields.find(field => field.name === 'employeeId').options.some(option => option.value === inactiveEmployee.id));
  const imported = f.imported({ employeeId: inactiveEmployee.id }), unchanged = f.state(); assert.equal((await f.request(f.admin, 'PATCH', route(imported), { version: 1, note: '仍須啟用' })).body.error.code, 'INACTIVE_ASSIGNMENT'); assert.deepEqual(f.state(), unchanged);
});

test('same-day literal-minute conflicts distinguish employee case adjacency cancellation and approved leave', async t => {
  const f = await fixture(t), before = f.state();
  for (const extra of [{ carePlanId: f.planB.id, caseId: f.caseB.id }, { employeeId: f.employeeB.id }]) {
    const result = await f.request(f.admin, 'POST', '/api/shifts', f.data({ ...extra, startTime: '09:30', endTime: '10:30' })); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), before);
  }
  const adjacent = await f.create('shifts', f.data({ startTime: '10:00', endTime: '11:00' })); assert.equal(adjacent.startTime, '10:00');
  const cancelled = await f.patch('shifts', f.shift, { status: 'cancelled' }); await f.create('shifts', f.data({ employeeId: f.employeeB.id })); assert.equal(cancelled.status, 'cancelled');
  for (const status of ['pending', 'rejected', 'cancelled']) await f.create('leave-requests', { employeeId: f.employeeA.id, date: '2026-10-15', startTime: '09:00', endTime: '10:00', type: '合成假別', status });
  const allowed = await f.create('shifts', f.data({ date: '2026-10-15' })); assert.equal(allowed.status, 'scheduled');
  await f.create('leave-requests', { employeeId: f.employeeA.id, date: '2026-10-16', startTime: '09:00', endTime: '10:00', type: '合成假別', status: 'approved' });
  const locked = f.state(), denied = await f.request(f.admin, 'POST', '/api/shifts', f.data({ date: '2026-10-16' })); assert.equal(denied.status, 409); assert.equal(denied.body.error.code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), locked);
  const overnight = await f.request(f.admin, 'POST', '/api/shifts', f.data({ date: '2026-10-17', startTime: '23:00', endTime: '01:00' })); assert.equal(overnight.body.error.code, 'TIME_RANGE');
});

test('every service-record state locks eight fields while note remains writable and approved billing never changes', async t => {
  const f = await fixture(t);
  for (const [index, status] of ['draft', 'submitted', 'returned', 'approved'].entries()) {
    let item = await f.create('shifts', f.data({ date: '2026-10-' + String(20 + index).padStart(2, '0') }));
    let record = await f.record(item, status === 'approved' ? 'submitted' : status);
    if (status === 'approved') { const result = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成完成' }); assert.equal(result.status, 200); record = await f.get('service-records', record); item = await f.get('shifts', item); }
    const before = f.state(), changes = [{ caseId: f.caseB.id, carePlanId: f.planB.id }, { employeeId: f.employeeB.id }, { carePlanId: f.planA2.id }, { date: '2026-11-' + String(20 + index).padStart(2, '0') }, { startTime: '09:10' }, { endTime: '10:10' }, { services: f.services.toReversed() }, { status: 'cancelled' }];
    for (const change of changes) { const result = await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...change }); assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.error.code, 'SHIFT_HAS_RECORD'); assert.deepEqual(f.state(), before); }
    const e = f.editor(item), payload = e.buildPayload({ note: '合成只改交班備註 ' + status }), saved = await f.patch('shifts', item, payload); e.confirm(saved, f.admin.org, payload);
    assert.deepEqual(await f.get('service-records', record), record); assert.deepEqual(projection(saved), { ...projection(item), note: payload.note });
    if (status === 'approved') { const bound = f.state(), overlap = await f.request(f.admin, 'POST', '/api/shifts', f.data({ date: item.date, startTime: '09:30', endTime: '10:30' })); assert.equal(overlap.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), bound); }
  }
});

test('fresh record and actual approval races reject stale edit or cancellation atomically without weakening CAS', async t => {
  const f = await fixture(t), item = f.shift, e = f.editor(item), payload = e.buildPayload({ employeeId: f.employeeB.id });
  const record = await f.record(item, 'submitted'), before = f.state();
  for (const change of [payload, { status: 'cancelled' }]) { const result = await f.request(f.admin, 'PATCH', route(item), { version: 1, ...change }); assert.equal(result.body.error.code, 'SHIFT_HAS_RECORD'); assert.deepEqual(f.state(), before); }
  await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成競態核閱' });
  const committed = f.state(), result = await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '過時編輯' }); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(f.state(), committed);
});

test('cancellation retains nine fields and original merged validation; manual completion still requires review', async t => {
  const f = await fixture(t), e = f.editor(f.shift), saved = await f.patch('shifts', f.shift, { status: 'cancelled' }); e.confirm(saved, f.admin.org, { status: 'cancelled' });
  assert.deepEqual(projection(saved), { ...projection(f.shift), status: 'cancelled' });
  const restored = await f.patch('shifts', saved, { status: 'scheduled' }); assert.equal(restored.status, 'scheduled', 'Existing API behavior is not a new UI restore action');
  const before = f.state(), complete = await f.request(f.admin, 'PATCH', route(restored), { version: restored.version, status: 'completed' }); assert.equal(complete.status, 422); assert.equal(complete.body.error.code, 'REVIEW_REQUIRED'); assert.deepEqual(f.state(), before);
  const malformed = f.imported({ startTime: '24:00' }), bound = f.state(); const result = await f.request(f.admin, 'PATCH', route(malformed), { version: 1, status: 'cancelled' }); assert.equal(result.body.error.code, 'TIME_RANGE'); assert.deepEqual(f.state(), bound);
});

test('canonical new payload and HTTP body boundaries reject malformed lists and preserve oversized existing optional text', async t => {
  const f = await fixture(t), before = f.state();
  for (const services of [[], null, 'x', [{ serviceItemId: f.serviceA.id, quantity: 0 }], [{ serviceItemId: f.serviceA.id, quantity: 10001 }], [{ serviceItemId: f.serviceA.id, quantity: '1' }], [{ serviceItemId: f.serviceA.id, quantity: 1, extra: true }], [...f.services, f.services[0]], Array.from({ length: 101 }, () => f.services[0])]) {
    assert.equal((await f.request(f.admin, 'PATCH', route(f.shift), { version: 1, services })).status, 422); assert.deepEqual(f.state(), before);
  }
  for (const payload of [{ note: null }, { note: {} }, { note: '字'.repeat(10001) }, { unknown: 'x' }, JSON.parse('{"__proto__":{"polluted":true}}')]) { assert.equal((await f.request(f.admin, 'PATCH', route(f.shift), { version: 1, ...payload })).status, 422); assert.deepEqual(f.state(), before); }
  const boundary = await f.patch('shifts', f.shift, { note: '🙂'.repeat(5000) }); assert.equal(boundary.note.length, 10000);
  const tiny = JSON.stringify({ version: boundary.version, note: '128KiB exact' }), exact = tiny + ' '.repeat(131072 - Buffer.byteLength(tiny)); assert.equal((await f.request(f.admin, 'PATCH', route(boundary), undefined, {}, exact)).status, 200);
  const committed = f.state(), huge = JSON.stringify({ version: boundary.version + 1, note: '不可抵達' }); assert.equal((await f.request(f.admin, 'PATCH', route(boundary), undefined, {}, huge + ' '.repeat(131073 - Buffer.byteLength(huge)))).status, 413); assert.deepEqual(f.state(), committed);
  const imported = f.imported({ note: 'n'.repeat(150000) }), e = f.editor(imported), payload = e.buildPayload({ employeeId: f.employeeB.id }), kept = await f.patch('shifts', imported, payload); e.confirm(kept, f.admin.org, payload); assert.equal(kept.note, imported.note);
});

test('POST same-key retry PATCH CAS CSRF and every nine-field acknowledgement protect concurrent changes', async t => {
  const f = await fixture(t), e = f.editor(), payload = e.buildPayload({ carePlanId: f.planA.id, employeeId: f.employeeA.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: f.services }), headers = { 'Idempotency-Key': 'synthetic-shift-once' };
  const first = await f.request(f.admin, 'POST', '/api/shifts', payload, headers); assert.equal(first.status, 201); e.confirm(first.body.item, f.admin.org, payload); const committed = f.state();
  assert.deepEqual((await f.request(f.admin, 'POST', '/api/shifts', payload, headers)).body, first.body); assert.deepEqual(f.state(), committed); assert.equal((await f.request(f.admin, 'POST', '/api/shifts', { ...payload, note: '另一內容' }, headers)).status, 409); assert.deepEqual(f.state(), committed);
  const original = first.body.item, pending = f.editor(original).buildPayload({ note: '我的未存修改' }), other = await f.patch('shifts', original, { note: '督導新版本' }, f.clients.supervisor), before = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', route(original), { version: 1, ...pending })).body.error.code, 'VERSION_CONFLICT');
  for (const token of ['', 'wrong']) assert.equal((await f.request(f.admin, 'PATCH', route(other), { version: 2, note: '拒絕' }, { 'X-CSRF-Token': token })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(other), { version: 2, note: '拒絕' }, { Origin: 'https://foreign.example.test' })).status, 403); assert.deepEqual(f.state(), before);
  const adapter = f.editor(other), change = adapter.buildPayload({ note: '實際新內容' }), saved = await f.patch('shifts', other, change), stable = f.state();
  for (const key of keys) { const missing = { ...saved }; delete missing[key]; assert.throws(() => adapter.confirm(missing, f.admin.org, change), error => error.code === 'SAVE_UNCONFIRMED'); const wrong = { ...saved, [key]: key === 'services' ? [] : '錯誤確認' }; assert.throws(() => adapter.confirm(wrong, f.admin.org, change), error => error.code === 'SAVE_UNCONFIRMED'); }
  for (const result of [null, [], {}, Object.create(saved), { ...saved, id: id() }, { ...saved, orgId: id() }, { ...saved, version: '3' }]) assert.throws(() => adapter.confirm(result, f.admin.org, change), error => error.code === 'SAVE_UNCONFIRMED');
  adapter.confirm(saved, f.admin.org, change); assert.deepEqual(f.state(), stable);
});

test('four actual roles and current employee assignment preserve precise historical case and employee gaps', async t => {
  const f = await fixture(t), before = f.state();
  for (const client of [f.clients.finance, f.clients.caregiver]) { assert.equal((await f.request(client, 'POST', '/api/shifts', f.data({ date: '2026-10-10' }))).status, 403); for (const payload of [{ note: '不可寫' }, { status: 'cancelled' }]) assert.equal((await f.request(client, 'PATCH', route(f.shift), { version: 1, ...payload })).status, 403); }
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.caregiver]) for (const url of [route(f.shift), history(f.shift), history(f.shift, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  assert.equal((await f.request(null, 'GET', route(f.shift))).status, 401); assert.deepEqual(f.state(), before);
  const b = await f.patch('shifts', f.shift, { employeeId: f.employeeB.id, caseId: f.caseB.id, carePlanId: f.planB.id }); assert.equal((await f.request(f.clients.caregiver, 'GET', history(b))).status, 404);
  const a = await f.patch('shifts', b, { employeeId: f.employeeA.id, caseId: f.caseA.id, carePlanId: f.planA.id });
  for (const compare of [false, true]) { const h = (await f.request(f.clients.caregiver, 'GET', history(a, compare))).body; assert.deepEqual(h.items.map(row => row.version), [3, 1]); if (compare) { assert.equal(h.items[0].comparison.status, 'unavailable'); assert.equal(h.items[0].comparison.previousSnapshot, null); } }
  assert.equal((await f.request(f.clients.caregiverB, 'GET', route(a))).status, 404);
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) assert.deepEqual((await f.request(client, 'GET', history(a))).body.items.map(row => row.version), [3, 2, 1]);
  const cancelled = await f.patch('shifts', a, { status: 'cancelled' }); assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/cases/' + f.caseA.id)).status, 200); assert.equal((await f.request(f.clients.caregiver, 'GET', route(cancelled))).status, 200);
  const missingCase = f.imported({ caseId: id() }); for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(client, 'GET', history(missingCase))).body.total, 0, 'All roles filter each historical case');
  const org = await f.create('organizations', { name: '合成隔離機構' }), outside = { ...f.admin, org: org.id }; for (const url of [route(a), history(a)]) assert.equal((await f.request(outside, 'GET', url)).status, 404);
});

test('28 versions retain exact previous page-boundary snapshots and actual actor identities without read writes', async t => {
  const f = await fixture(t); let item = f.shift;
  for (let version = 2; version <= 28; version++) { const e = f.editor(item), payload = e.buildPayload({ note: '合成版本 ' + version }); item = await f.patch('shifts', item, payload, version % 2 ? f.admin : f.clients.supervisor); e.confirm(item, f.admin.org, payload); }
  const before = f.state(), a = (await f.request(f.admin, 'GET', history(item) + '&page=1&pageSize=25')).body, b = (await f.request(f.admin, 'GET', history(item) + '&page=2&pageSize=25')).body;
  assert.equal(a.total, 28); assert.equal(a.items.length, 25); assert.equal(b.items.length, 3); assert.deepEqual([...a.items, ...b.items].map(row => row.version), Array.from({ length: 28 }, (_, i) => 28 - i));
  assert.equal(a.items.at(-1).comparison.previousVersion, 3); assert.equal(a.items.at(-1).comparison.previousSnapshot.note, '合成版本 3'); assert.equal(a.items.at(-1).actor.id, f.clients.supervisor.user.id); assert.equal(b.items.at(-1).comparison.status, 'initial'); assert.deepEqual(f.state(), before);
});

test('shift writes never cascade non-shift records approved billing or files;31 report outlets and four BLOB reads preserve eleven tables', async t => {
  const f = await fixture(t), approved = await f.approve();
  const cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成班次證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成班次PDF', ...filePayload(PDF_BYTES) });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成班次PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  const related = () => f.app.db.prepare("SELECT * FROM records WHERE entity!='shifts' ORDER BY rowid").all(), original = related();
  let item = await f.create('shifts', f.data({ date: '2026-10-10' }));
  for (const change of [{ employeeId: f.employeeB.id, carePlanId: f.planB.id }, { servicesIntent: 'replace', services: [{ serviceItemId: f.serviceB.id, quantity: 10000 }] }, { note: '合成新交班' }]) { const e = f.editor(item), payload = e.buildPayload(change); item = await f.patch('shifts', item, payload); e.confirm(item, f.admin.org, payload); assert.deepEqual(related(), original); }
  const old = item; item = await f.patch('shifts', old, { status: 'cancelled' }); f.editor(old).confirm(item, f.admin.org, { status: 'cancelled' }); assert.deepEqual(related(), original);
  const urls = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-09' : ''}`);
  for (const suffix of ['', '/export', '.csv']) urls.push('/api/employee-report' + suffix); assert.equal(urls.length, 31);
  const before = f.state(), triggers = f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(); assert.equal(triggers.length, 6); assert.equal(Object.keys(before.tables).length, 11); assert(before.tables.attachment_files.length && before.tables.certification_attachment_files.length);
  const reports = async () => { const result = {}; for (const url of urls) { const response = await f.request(f.admin, 'GET', url); assert.equal(response.status, 200, url); result[url] = typeof response.body === 'string' ? response.body : Object.fromEntries(Object.entries(response.body).filter(([key]) => key !== 'generatedAt')); } return result; };
  const first = await reports();
  for (const [url, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const response = await f.request(f.admin, 'GET', url + suffix); assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes); assert.equal(sha(response.bytes), sha(bytes)); }
  assert.deepEqual(await reports(), first); assert.deepEqual(await f.get('service-records', approved), approved); assert.equal((await f.request(f.admin, 'GET', history(await f.get('shifts', f.shift)))).body.items.find(row => row.snapshot.status === 'completed').actor.id, f.clients.supervisor.user.id);
  for (const client of [f.clients.supervisor, f.clients.caregiver]) assert(!Object.hasOwn(await f.get('service-records', approved, client), 'billingSnapshot'));
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), triggers);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) { assert.throws(() => f.app.db.exec('DELETE FROM ' + table), /immutable/); assert.throws(() => f.app.db.exec('UPDATE ' + table + ' SET ' + (table === 'record_versions' ? 'version=version' : 'id=id')), /immutable/); }
  assert.deepEqual(f.state(), before);
});
