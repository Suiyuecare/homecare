import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { createAttachmentMetadataEditor, confirmAttachmentMetadataList } from '../public/data/attachment-metadata-editor.js';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

// These tests exercise real HTTP and the unchanged server, using private synthetic memory SQLite.
// The file bytes, approved price snapshot, other records and every non-target table are protected.
const entities = ['case-attachments', 'certification-attachments'];
const parentKey = entity => entity === 'case-attachments' ? 'caseId' : 'certificationId';
const route = (entity, item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
const fileKeys = ['fileName', 'mimeType', 'sizeBytes', 'sha256'];

async function fixture(t, entity) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  assert.equal(app.dbPath, ':memory:'); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  t.after(() => app.close());
  const password = 'synthetic-attachment-metadata-password';
  async function request(actor, method, url, payload, extraHeaders = {}) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf, 'X-Org-Id': actor.org } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (response.headers.get('content-type')?.includes('application/json')) return { status: response.status, headers: response.headers, body: await response.json() };
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成附件管理者', email: 'admin@attachment-metadata.example.test', password, organizationName: '合成附件機構甲' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(name, values, actor = admin) { const result = await request(actor, 'POST', '/api/' + name, values); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; }
  const employee = await create('employees', { name: '合成附件居服員', employeeNo: 'META-E', hourlyRateCents: 24123 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@attachment-metadata.example.test';
    await create('users', { name: '合成附件' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseA = await create('cases', { name: '合成附件個案甲', caseNo: 'META-A' }), caseB = await create('cases', { name: '合成附件個案乙', caseNo: 'META-B' });
  const certA = await create('employee-certifications', { employeeId: employee.id, name: '合成附件證照甲', issuedOn: '2026-01-01' });
  const certB = await create('employee-certifications', { employeeId: employee.id, name: '合成附件證照乙', issuedOn: '2026-01-01' });
  const service = await create('service-items', { code: 'META-S', name: '合成保存服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services });
  const submitted = await create('service-records', { caseId: caseA.id, employeeId: employee.id, shiftId: shift.id, date: shift.date, actualStart: '09:03', actualEnd: '09:54', services, status: 'submitted', note: '合成保存觀察' });
  assert.equal((await request(clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成保存核閱' })).status, 200);
  assert(Object.hasOwn((await request(admin, 'GET', '/api/service-records/' + submitted.id)).body.item, 'billingSnapshot'));
  const caseAttachment = await create('case-attachments/upload', { caseId: caseA.id, title: '合成個案PDF', note: '合成原備註', ...filePayload(PDF_BYTES) });
  const certAttachment = await create('certification-attachments/upload', { certificationId: certA.id, title: '合成證照PNG', note: '合成原備註', ...filePayload(PNG_BYTES, '合成證照.png', 'image/png') });
  const item = entity === 'case-attachments' ? caseAttachment : certAttachment;
  const parentId = entity === 'case-attachments' ? caseA.id : certA.id, otherParentId = entity === 'case-attachments' ? caseB.id : certB.id;
  const foreignOrg = await create('organizations', { name: '合成附件機構乙' }), foreign = { ...admin, org: foreignOrg.id };
  const state = () => {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table').map(row => row.name); assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })), changes: app.db.prepare('SELECT total_changes() n').get().n };
  };
  async function readOnly(action, expected) { const before = state(), result = await action(); if (expected !== undefined) assert.equal(result.status, expected, JSON.stringify(result.body)); assert.deepEqual(state(), before); return result; }
  const get = async (record = item, actor = admin) => (await readOnly(() => request(actor, 'GET', route(entity, record)), 200)).body.item;
  // Explicit fixture preparation is outside read/mutation proofs and never modifies BLOBs or parent records.
  function fixtureMetadata(changes, remove = []) {
    const row = app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id), data = JSON.parse(row.data);
    Object.assign(data, changes); for (const key of remove) delete data[key];
    app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data), item.id);
    return { ...data, id: row.id, orgId: row.org_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  const editor = record => createAttachmentMetadataEditor({ entity, existing: record, parentId, ...(entity === 'certification-attachments' ? { employeeId: employee.id } : {}) });
  async function patch(record, payload, actor = admin) {
    const before = state(), result = await request(actor, 'PATCH', route(entity, record), { ...payload, version: record.version });
    assert.equal(result.status, 200, JSON.stringify(result.body)); const updated = result.body.item, after = state(); editor(record).confirm(updated, admin.org, payload);
    assert.deepEqual(after.schema, before.schema); assert.equal(after.changes - before.changes, 3);
    for (const [name, rows] of Object.entries(before.tables)) if (!['records', 'record_versions', 'audit'].includes(name)) assert.deepEqual(after.tables[name], rows, name);
    assert.deepEqual(after.tables.records.filter(row => row.id !== record.id), before.tables.records.filter(row => row.id !== record.id));
    assert.equal(after.tables.records.length, before.tables.records.length);
    const oldRow = before.tables.records.find(row => row.id === record.id), newRow = after.tables.records.find(row => row.id === record.id);
    assert.equal(newRow.org_id, oldRow.org_id); assert.equal(newRow.entity, oldRow.entity); assert.equal(newRow.created_at, oldRow.created_at); assert.equal(newRow.version, oldRow.version + 1n);
    const oldData = JSON.parse(oldRow.data), newData = JSON.parse(newRow.data), expectedData = { ...oldData, ...payload };
    for (const key of Object.keys(payload)) if (typeof expectedData[key] === 'string') expectedData[key] = expectedData[key].trim();
    assert.deepEqual(newData, expectedData); assert.equal(newData.fileId, oldData.fileId);
    assert.deepEqual(after.tables.record_versions.slice(0, before.tables.record_versions.length), before.tables.record_versions); assert.equal(after.tables.record_versions.length, before.tables.record_versions.length + 1);
    const version = after.tables.record_versions.at(-1); assert.equal(version.record_id, record.id); assert.equal(version.org_id, admin.org); assert.equal(version.entity, entity); assert.equal(version.version, BigInt(updated.version)); assert.equal(version.source, 'update');
    assert.deepEqual(JSON.parse(version.snapshot), { ...updated, fileId: oldData.fileId });
    assert.deepEqual(after.tables.audit.slice(0, before.tables.audit.length), before.tables.audit); assert.equal(after.tables.audit.length, before.tables.audit.length + 1);
    const audit = after.tables.audit.at(-1); assert.equal(audit.record_id, record.id); assert.equal(audit.org_id, actor.org); assert.equal(audit.entity, entity); assert.equal(audit.user_id, actor.user.id); assert.equal(audit.action, 'record.update'); assert.equal(JSON.parse(audit.detail).version, updated.version);
    assert.deepEqual(JSON.parse(audit.detail).fields, Object.keys(payload));
    assert(!Object.hasOwn(updated, 'fileId')); for (const key of fileKeys) assert.deepEqual(updated[key], record[key]); return updated;
  }
  return { entity, app, request, admin, clients, foreign, item, parentId, otherParentId, employee, caseA, certA, state, readOnly, get, fixtureMetadata, editor, patch };
}

for (const entity of entities) {
  test(entity + ': no-op and a single metadata edit preserve original CR/LF, spacing, private file and all protected state', async t => {
    const f = await fixture(t, entity); f.fixtureMetadata({ title: '  原始標題  ', note: '  合成首行\r\n次行\r尾行  ' });
    const original = await f.get(), e = f.editor(original); assert.deepEqual(e.buildPayload(e.initial), {});
    const payload = e.buildPayload({ ...e.initial, title: '  明確新標題  ' }); assert.deepEqual(payload, { title: '明確新標題' });
    const updated = await f.patch(original, payload, f.clients.supervisor); assert.equal(updated.note, original.note);
    const before = f.state(); const history = await f.request(f.admin, 'GET', route(entity, updated, '/history?compare=previous'));
    assert.equal(history.status, 200); assert.deepEqual(history.body.items[0].actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name }); assert.equal(history.body.items[0].comparison.previousVersion, 1); assert.deepEqual(f.state(), before);
  });
  test(entity + ': explicit LF note replacement trims only supplied text and leaves a non-native title intact', async t => {
    const f = await fixture(t, entity); f.fixtureMetadata({ title: '  原標題\r\n保留  ', note: '第一行\n第二行' });
    const original = await f.get(), e = f.editor(original); assert.equal(e.initial.titleIntent, 'keep');
    const payload = e.buildPayload({ ...e.initial, note: '  明確首行\n明確尾行  ' }); assert.deepEqual(payload, { note: '明確首行\n明確尾行' });
    const updated = await f.patch(original, payload); assert.equal(updated.title, original.title); assert.equal(updated.note, '明確首行\n明確尾行');
  });
  test(entity + ': missing optional note retains own-presence until an explicit clear creates the saved empty value', async t => {
    const f = await fixture(t, entity); f.fixtureMetadata({}, ['note']); const original = await f.get(), e = f.editor(original); assert(!Object.hasOwn(original, 'note'));
    const titleOnly = await f.patch(original, e.buildPayload({ ...e.initial, title: '只改標題' })); assert(!Object.hasOwn(titleOnly, 'note'));
    const next = f.editor(titleOnly), cleared = await f.patch(titleOnly, next.buildPayload({ ...next.initial, noteIntent: 'clear' })); assert(Object.hasOwn(cleared, 'note')); assert.equal(cleared.note, '');
  });
  test(entity + ': keeping legacy invalid JSON cannot bypass merged validation; explicit repair is required', async t => {
    const f = await fixture(t, entity); f.fixtureMetadata({ title: null, note: { syntheticHidden: 'do-not-expand' }, status: 'unknown', ...(entity === 'case-attachments' ? { category: ['unknown'] } : {}) });
    const original = await f.get(), e = f.editor(original); assert.deepEqual(e.buildPayload(e.initial), {});
    await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, original), { version: 1, title: '只修標題' }), 422);
    const values = { ...e.initial, titleIntent: 'replace', title: '明確修復標題', noteIntent: 'clear', statusRepair: 'active', ...(entity === 'case-attachments' ? { categoryIntent: 'replace', category: 'care' } : {}) };
    const payload = e.buildPayload(values), updated = await f.patch(original, payload); assert.equal(updated.title, '明確修復標題'); assert.equal(updated.note, ''); assert.equal(updated.status, 'active');
  });
  test(entity + ': original role, organization, parent, CSRF and derived metadata guards reject with zero writes', async t => {
    const f = await fixture(t, entity), original = await f.get();
    for (const role of ['finance', 'caregiver']) await f.readOnly(() => f.request(f.clients[role], 'PATCH', route(entity, original), { version: 1, note: '不可變更' }), 403);
    for (const suffix of ['', '/history?compare=previous', '/download']) await f.readOnly(() => f.request(f.foreign, 'GET', route(entity, original, suffix)), 404);
    if (entity === 'certification-attachments') await f.readOnly(() => f.request(f.clients.finance, 'GET', route(entity, original)), 403);
    else await f.readOnly(() => f.request(f.clients.finance, 'GET', route(entity, original)), 200);
    await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, original), { version: 1, [parentKey(entity)]: f.otherParentId }), 409);
    await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, original), { version: 1, note: '不可變更' }, { 'X-CSRF-Token': 'synthetic-wrong' }), 403);
    for (const data of [{ fileName: '不可改.pdf' }, { mimeType: 'image/jpeg' }, { sizeBytes: 999 }, { sha256: '0'.repeat(64) }, { fileId: 'private-not-writable' }, ...(entity === 'certification-attachments' ? [{ employeeId: f.employee.id }] : [])])
      await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, original), { version: 1, ...data }), 422);
  });
  test(entity + ': a committed PATCH cannot be replayed by an idempotency header; original CAS preserves the current target', async t => {
    const f = await fixture(t, entity), original = await f.get(), e = f.editor(original), payload = e.buildPayload({ ...e.initial, title: '已保存但需確認標題' });
    const updated = await f.patch(original, payload, f.clients.supervisor);
    const replay = await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, original), { version: original.version, ...payload }, { 'Idempotency-Key': 'synthetic-ignored-metadata-key' }), 409);
    assert.equal(replay.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(await f.get(), updated);
    const current = f.editor(updated); const changed = await f.patch(updated, current.buildPayload({ ...current.initial, note: '重新讀取後明確修改' })); assert.equal(changed.version, 3);
  });
  test(entity + ': original text boundaries and status-only transitions preserve file and parent data', async t => {
    const f = await fixture(t, entity), original = await f.get(), e = f.editor(original);
    let item = await f.patch(original, e.buildPayload({ ...e.initial, title: '字'.repeat(200), note: '註'.repeat(10000) }));
    for (const bad of [{ title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { note: 'x'.repeat(10001) }, { status: 'deleted' }, ...(entity === 'case-attachments' ? [{ category: 'medical' }] : [])])
      await f.readOnly(() => f.request(f.admin, 'PATCH', route(entity, item), { ...bad, version: item.version }), 422);
    item = await f.patch(item, f.editor(item).buildStatusChange('inactive')); assert.equal(item.status, 'inactive');
    item = await f.patch(item, f.editor(item).buildStatusChange('active'), f.clients.supervisor); assert.equal(item.status, 'active'); assert.equal(item.title.length, 200); assert.equal(item.note.length, 10000);
  });
  test(entity + ': list, detail, history and exact old/current downloads remain read-only and publicly scoped', async t => {
    const f = await fixture(t, entity), original = await f.get(), updated = await f.patch(original, { note: '合成查詢備註' });
    for (const actor of [f.admin, f.clients.supervisor, f.clients.caregiver, ...(entity === 'case-attachments' ? [f.clients.finance] : [])]) {
      const url = route(entity) + '?' + new URLSearchParams({ [parentKey(entity)]: f.parentId, page: '1', pageSize: '25', status: 'active', ...(entity === 'case-attachments' ? { category: 'general' } : {}) });
      const list = await f.readOnly(() => f.request(actor, 'GET', url), 200);
      confirmAttachmentMetadataList(list.body, { entity, orgId: f.admin.org, parentId: f.parentId, employeeId: f.employee.id, page: 1, pageSize: 25, status: 'active', category: entity === 'case-attachments' ? 'general' : '' });
      assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, updated.id);
      const history = await f.readOnly(() => f.request(actor, 'GET', route(entity, updated, '/history?compare=previous')), 200); assert.equal(history.body.items[0].comparison.previousVersion, 1); assert(!JSON.stringify(history.body).includes('fileId'));
      for (const suffix of ['/download?recordVersion=1', '/download?recordVersion=2', '/download']) {
        const file = await f.readOnly(() => f.request(actor, 'GET', route(entity, updated, suffix)), 200); assert.deepEqual(file.bytes, entity === 'case-attachments' ? PDF_BYTES : PNG_BYTES);
      }
    }
  });
}
