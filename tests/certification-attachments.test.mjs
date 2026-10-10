import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { id, now, business } from '../src/server/model.mjs';
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_BODY_BYTES } from '../src/server/attachments.mjs';
import { insertCertificationAttachmentFile } from '../src/server/certification-attachments.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const ENTITY = 'certification-attachments', CERT = 'employee-certifications';
const route = (item, suffix = '') => '/api/' + ENTITY + (item ? '/' + item.id : '') + suffix;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const password = 'synthetic-certification-attachment-password';
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const actor = client => ({ id: client.user.id, name: client.user.name });

async function fixture(t, dbPath = ':memory:') {
  let app = createApp({ dbPath, port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extraHeaders = {}, rawBody) {
    const response = await fetch(base + url, { method, headers: {
      Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders,
    }, ...(rawBody !== undefined ? { body: rawBody } : data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : null, bytes, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成證照附件管理員', email: 'cert-attachment-admin@example.test', password, organizationName: '合成證照附件甲機構' });
  assert.equal(setup.status, 201);
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup);
  async function create(entity, data, client = admin) {
    const response = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function edit(entity, item, data, client = admin) {
    const response = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成員工甲', employeeNo: 'TEST-CA-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成員工乙', employeeNo: 'TEST-CA-B' });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@cert-attachments.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    clients[key] = clientFrom(await request(null, 'POST', '/api/login', { email, password }));
  }
  const certData = (employee = employeeA, overrides = {}) => ({ employeeId: employee.id, name: '合成證照', issuedOn: '2026-01-01', expiresOn: '2026-10-08', ...overrides });
  const certA = await create(CERT, certData()), certA2 = await create(CERT, certData(employeeA, { name: '合成另一張證照' })), certB = await create(CERT, certData(employeeB));
  const payload = (overrides = {}) => ({ certificationId: certA.id, title: '合成證照附件', ...filePayload(), ...overrides });
  async function upload(data = payload(), client = admin, headers = {}) {
    const response = await request(client, 'POST', route(null, '/upload'), data, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  const patch = (item, data, client = admin) => edit(ENTITY, item, data, client);
  async function replaceFile(item, data = filePayload(PNG_BYTES, '合成新版.png', 'image/png'), client = admin, headers = {}) {
    const response = await request(client, 'POST', route(item, '/replace-file'), { version: item.version, ...data }, headers);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const counts = () => Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n]));
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const stored = item => JSON.parse(app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
  function imported(fields, version = 1) {
    const item = { ...fields, id: id(), orgId: admin.org, version, createdAt: now(), updatedAt: now() };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, item.orgId, ENTITY, JSON.stringify(business(item)), version, item.createdAt, item.updatedAt); return item;
  }
  function addVersion(item, version, changes = {}, scope = {}) {
    const snapshot = { ...stored(item), id: item.id, orgId: admin.org, version, createdAt: item.createdAt, updatedAt: now(), ...changes };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(scope.orgId || admin.org, scope.entity || ENTITY, item.id, version, JSON.stringify(snapshot), now(), 'baseline'); return snapshot;
  }
  function auditEvent(item, changes = {}) {
    const { orgId = admin.org, entity = ENTITY, recordId = item.id, userId = admin.user.id, action = 'record.update', detail = { version: item.version } } = changes;
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, JSON.stringify(detail), now());
  }
  return { get app() { return app; }, request, create, edit, admin, clients, employeeA, employeeB, certA, certA2, certB, certData, payload, upload, patch, replaceFile, counts, state, stored, imported, addVersion, auditEvent, async reopen() { await app.close(); app = createApp({ dbPath, port: 0 }); base = await app.listen(); } };
}

test('certification attachments preserve fixed parents, exact bytes, private file IDs and actual upload/edit/replacement actors', async t => {
  const f = await fixture(t);
  const parentsBefore = await Promise.all([['employees', f.employeeA], [CERT, f.certA]].map(async ([entity, item]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history')).body));
  let item = await f.upload(f.payload({ title: ' 合成附件標題 ', note: ' 合成備註 ', fileName: ' 合成"證照.PDF ' }));
  assert.equal(item.employeeId, f.employeeA.id); assert.equal(item.title, '合成附件標題'); assert.equal(item.note, '合成備註'); assert.equal(item.fileName, '合成"證照.PDF');
  assert.equal(item.sha256, digest(PDF_BYTES)); assert.equal(item.sizeBytes, PDF_BYTES.length); assert.ok(!Object.hasOwn(item, 'fileId'));
  const initialFileId = f.stored(item).fileId;
  item = await f.patch(item, { certificationId: f.certA.id, title: '合成第二版' }, f.clients.supervisor);
  assert.equal(f.stored(item).fileId, initialFileId); assert.equal(f.counts().certification_attachment_files, 1);
  item = await f.replaceFile(item, undefined, f.clients.supervisor);
  assert.equal(item.version, 3); assert.notEqual(f.stored(item).fileId, initialFileId); assert.equal(f.counts().certification_attachment_files, 2);
  item = await f.patch(item, { status: 'inactive' }); item = await f.patch(item, { status: 'active' }, f.clients.supervisor);
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    for (const url of [route(), route(item), route(item, '/history'), route(item, '/history?compare=previous')]) {
      const response = await f.request(client, 'GET', url); assert.equal(response.status, 200);
      assert.ok(!JSON.stringify(response.body).includes('fileId')); assert.ok(!JSON.stringify(response.body).includes('contentBase64'));
    }
    for (const version of [1, 2, 3, 4, 5, null]) {
      const expected = version && version <= 2 ? PDF_BYTES : PNG_BYTES;
      const result = await f.request(client, 'GET', route(item, '/download' + (version ? '?recordVersion=' + version : '')));
      assert.equal(result.status, 200); assert.deepEqual(result.bytes, expected); assert.equal(Number(result.headers.get('content-length')), expected.length);
      assert.equal(result.headers.get('content-type'), expected === PDF_BYTES ? 'application/pdf' : 'image/png');
      assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.match(result.headers.get('content-disposition'), /^attachment; filename="attachment\.(pdf|png)"; filename\*=UTF-8''/);
      if (version === 1) assert.ok(result.headers.get('content-disposition').includes('%22'));
    }
  }
  const history = (await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body.items;
  assert.deepEqual(history.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.clients.supervisor), actor(f.admin)]);
  assert.equal(history[2].comparison.previousSnapshot.sha256, digest(PDF_BYTES)); assert.equal(history[2].comparison.previousVersion, 2);
  assert.deepEqual(history.at(-1).comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
  assert.deepEqual(await Promise.all([['employees', f.employeeA], [CERT, f.certA]].map(async ([entity, parent]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + parent.id + '/history')).body)), parentsBefore);
  assert.deepEqual(f.state(), before);
});

test('certification metadata rejects upload bypass, client-derived fields and mutable certificate ownership', async t => {
  const f = await fixture(t), item = await f.upload(), before = f.counts();
  const plain = await f.request(f.admin, 'POST', route(), f.payload()); assert.equal(plain.status, 405); assert.equal(plain.body.error.code, 'UPLOAD_REQUIRED');
  for (const fields of [{ title: '' }, { title: '  ' }, { title: 2 }, { title: 'x'.repeat(201) }, { note: 'x'.repeat(10001) }, { status: 'deleted' }, { certificationId: '' }]) {
    assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(fields))).status, 422);
  }
  for (const field of ['employeeId', 'fileId', 'sizeBytes', 'sha256', 'category']) {
    const result = await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ [field]: 'injected' })); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'UNKNOWN_FIELD');
  }
  for (const field of ['employeeId', 'fileId', 'fileName', 'mimeType', 'sizeBytes', 'sha256', 'contentBase64', 'category']) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: 1, [field]: 'injected' }); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'UNKNOWN_FIELD');
  }
  for (const certificationId of [f.certA2.id, f.certB.id, id(), '']) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: 1, certificationId }); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CERTIFICATION_IMMUTABLE');
  }
  for (const certificationId of [id(), f.employeeA.id]) assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ certificationId }))).status, 404);
  assert.equal((await f.request(f.admin, 'POST', route(item, '/replace-file'), { version: 1, ...filePayload(), title: 'metadata forbidden here' })).status, 422);
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404);
  assert.deepEqual(f.counts(), before);
  const boundary = await f.upload(f.payload({ title: '字'.repeat(200), note: '字'.repeat(10000) })); assert.equal(boundary.title.length, 200);
});

test('certification file validation shares canonical encoding, signatures, filenames and exact decoded/body limits', async t => {
  const f = await fixture(t), before = f.counts();
  for (const fields of [
    { contentBase64: '' }, { contentBase64: 'AB==' }, { contentBase64: 'A===' }, { contentBase64: 'AA==' }, { contentBase64: null },
    { contentBase64: PDF_BYTES.toString('base64') + '\n' }, { contentBase64: 'data:application/pdf;base64,' + PDF_BYTES.toString('base64') },
    { contentBase64: PDF_BYTES.toString('base64').replace(/=$/, '') }, { contentBase64: '%%%%' },
    { fileName: '' }, { fileName: 'x'.repeat(177) + '.pdf' }, { fileName: '../test.pdf' }, { fileName: 'a\\test.pdf' }, { fileName: 'a\u0000.pdf' },
    { fileName: 'a\r\nInjected.pdf' }, { fileName: 'a\u007f.pdf' }, { fileName: 'a\ud800.pdf' }, { fileName: 'a.html' },
    { mimeType: 'text/html' }, { fileName: 'a.png' }, { mimeType: 'image/png' }, { contentBase64: Buffer.from('NOT PDF').toString('base64') },
    filePayload(PNG_BYTES, 'a.jpg', 'image/jpeg'),
  ]) {
    const result = await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(fields));
    assert.equal(result.status, 422, JSON.stringify(fields)); assert.ok(result.body.error.fields.file);
  }
  assert.deepEqual(f.counts(), before);
  const max = Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES, 32); PDF_BYTES.copy(max);
  const data = f.payload(filePayload(max, 'x'.repeat(176) + '.pdf'));
  const maxItem = await f.upload(data); assert.equal(maxItem.sizeBytes, MAX_ATTACHMENT_FILE_BYTES); assert.equal(maxItem.fileName.length, 180);
  const exactBody = JSON.stringify(data), padded = exactBody + ' '.repeat(MAX_ATTACHMENT_BODY_BYTES - Buffer.byteLength(exactBody));
  assert.equal(Buffer.byteLength(padded), MAX_ATTACHMENT_BODY_BYTES);
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), undefined, {}, padded)).status, 201);
  const overBody = await f.request(f.admin, 'POST', route(null, '/upload'), undefined, {}, padded + ' ');
  assert.equal(overBody.status, 413); assert.equal(overBody.body.error.code, 'BODY_TOO_LARGE');
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(filePayload(Buffer.concat([max, Buffer.from('x')]))))).status, 413);
  const replaceData = JSON.stringify({ version: maxItem.version, ...filePayload(max) });
  assert.equal((await f.request(f.admin, 'POST', route(maxItem, '/replace-file'), undefined, {}, replaceData + ' '.repeat(MAX_ATTACHMENT_BODY_BYTES - Buffer.byteLength(replaceData)))).status, 200);
  assert.equal((await f.request(f.admin, 'POST', route(maxItem, '/replace-file'), undefined, {}, replaceData + ' '.repeat(MAX_ATTACHMENT_BODY_BYTES + 1 - Buffer.byteLength(replaceData)))).status, 413);
  const current = (await f.request(f.admin, 'GET', route(maxItem))).body.item;
  const metadata = JSON.stringify({ version: current.version, note: '普通 metadata 仍用原上限' });
  assert.equal((await f.request(f.admin, 'PATCH', route(current), undefined, {}, metadata + ' '.repeat(131072 - Buffer.byteLength(metadata)))).status, 200);
  assert.equal((await f.request(f.admin, 'PATCH', route(current), undefined, {}, metadata + ' '.repeat(131073 - Buffer.byteLength(metadata)))).status, 413);
  assert.ok((await f.upload(f.payload(filePayload(PNG_BYTES, 'VALID.PNG', 'image/png')))).id);
  // Basic JPEG signature validation is not a claim of complete decoding or virus scanning.
  assert.ok((await f.upload(f.payload(filePayload(Buffer.from([255, 216, 255, 217]), 'signature.JPEG', 'image/jpeg')))).id);
});

test('certification attachment role and organization guards deny finance early and allow only the linked caregiver parent', async t => {
  const f = await fixture(t), mine = await f.upload(f.payload({ status: 'inactive' })), hidden = await f.upload(f.payload({ certificationId: f.certB.id, title: 'PRIVATE OTHER EMPLOYEE' }));
  const org = await f.create('organizations', { name: '合成證照附件乙機構' }), foreignClient = { ...f.admin, org: org.id };
  const employee = await f.create('employees', { name: '合成外機構員工', employeeNo: 'TEST-CA-FOREIGN' }, foreignClient);
  const cert = await f.create(CERT, f.certData(employee), foreignClient), foreign = await f.upload(f.payload({ certificationId: cert.id }), foreignClient);
  const before = f.state();
  for (const suffix of ['', '/history', '/history?compare=previous', '/download', '/download?recordVersion=1']) {
    assert.equal((await f.request(f.clients.carerA, 'GET', route(mine, suffix))).status, 200);
    assert.equal((await f.request(f.clients.carerA, 'GET', route(hidden, suffix))).status, 404);
    assert.equal((await f.request(f.clients.carerB, 'GET', route(mine, suffix))).status, 404);
    assert.equal((await f.request(f.admin, 'GET', route(foreign, suffix))).status, 404);
    assert.equal((await f.request(foreignClient, 'GET', route(mine, suffix))).status, 404);
    assert.equal((await f.request(f.clients.finance, 'GET', route(mine, suffix))).status, 403);
    assert.equal((await f.request(null, 'GET', route(mine, suffix))).status, 401);
  }
  assert.equal((await f.request(f.clients.carerA, 'GET', route())).body.total, 1);
  assert.equal((await f.request(f.clients.carerA, 'GET', route(null, '?q=PRIVATE'))).body.total, 0);
  assert.equal((await f.request(f.clients.finance, 'GET', route(null, '?certificationId=invalid'))).status, 403);
  for (const caller of [f.clients.carerA, f.clients.finance]) for (const [method, url] of [['POST', route()], ['POST', route(null, '/upload')], ['POST', route(mine, '/replace-file')], ['PATCH', route(mine)]]) {
    const result = await f.request(caller, method, url, undefined, {}, '{'); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN');
  }
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ certificationId: cert.id }))).status, 404);
  for (const [method, url, data] of [['POST', route(null, '/upload'), f.payload()], ['POST', route(mine, '/replace-file'), { version: 1, ...filePayload() }], ['PATCH', route(mine), { version: 1, note: 'csrf' }]]) {
    assert.equal((await f.request(f.admin, method, url, data, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request(f.admin, method, url, data, { Origin: 'https://foreign.example.test' })).status, 403);
  }
  assert.deepEqual(f.state(), before);
});

test('revoked or inactive parents remain maintainable while missing, foreign and contaminated current parents disappear', async t => {
  const f = await fixture(t);
  await f.edit(CERT, f.certA, { status: 'revoked', expiresOn: '2026-01-02' });
  await f.edit('employees', f.employeeA, { status: 'inactive' });
  let item = await f.upload(f.payload({ status: 'inactive' }), f.clients.supervisor);
  item = await f.patch(item, { note: 'inactive parents are still maintainable' }); item = await f.replaceFile(item);
  for (const client of [f.admin, f.clients.supervisor]) assert.equal((await f.request(client, 'GET', route(item, '/download'))).status, 200);
  assert.equal((await f.request(f.clients.carerA, 'GET', route(item))).status, 403);
  f.app.db.prepare('UPDATE memberships SET employee_id=NULL WHERE org_id=? AND user_id=?').run(f.admin.org, f.clients.carerB.user.id);
  assert.equal((await f.request(f.clients.carerB, 'GET', route())).status, 403);
  const restored = (await f.request(f.admin, 'GET', '/api/employees/' + f.employeeA.id)).body.item;
  await f.edit('employees', restored, { status: 'active' });
  const alienOrg = await f.create('organizations', { name: '合成父項污染外機構' }), alien = { ...f.admin, org: alienOrg.id };
  const alienEmployee = await f.create('employees', { name: '合成外員工', employeeNo: 'TEST-CA-ALIEN' }, alien);
  const alienCert = await f.create(CERT, f.certData(alienEmployee), alien);
  const base = f.stored(item), bad = [
    f.imported({ ...base, certificationId: id() }), f.imported({ ...base, certificationId: f.employeeA.id }),
    f.imported({ ...base, certificationId: alienCert.id }), f.imported({ ...base, employeeId: f.employeeB.id }),
  ];
  const orphanCert = await f.create(CERT, f.certData());
  const orphanAttachment = await f.upload(f.payload({ certificationId: orphanCert.id }));
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(orphanCert), employeeId: id() }), orphanCert.id);
  bad.push(orphanAttachment);
  const foreignEmployeeCert = await f.create(CERT, f.certData());
  const foreignEmployeeAttachment = await f.upload(f.payload({ certificationId: foreignEmployeeCert.id }));
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(foreignEmployeeCert), employeeId: alienEmployee.id }), foreignEmployeeCert.id);
  bad.push(foreignEmployeeAttachment);
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) for (const invalid of bad) {
    for (const suffix of ['', '/history', '/history?compare=previous', '/download']) assert.equal((await f.request(client, 'GET', route(invalid, suffix))).status, 404);
  }
  for (const invalid of bad) {
    assert.equal((await f.request(f.admin, 'PATCH', route(invalid), { version: 1, title: 'cannot revive corrupted parent' })).status, 404);
    assert.equal((await f.request(f.admin, 'POST', route(invalid, '/replace-file'), { version: 1, ...filePayload() })).status, 404);
  }
  assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT + '/' + orphanCert.id)).status, 200, 'original certificate detail keeps its existing orphan semantics');
  assert.equal((await f.request(f.admin, 'GET', route())).body.total, 1);
  assert.deepEqual(f.state(), before);
});

test('successful idempotency retries preserve blobs and reauthorize current parents before returning cached responses', async t => {
  const f = await fixture(t), payload = f.payload(), uploadKey = { 'Idempotency-Key': 'cert-upload-once' };
  const initial = await f.upload(payload, f.admin, uploadKey), replacement = filePayload(PNG_BYTES, 'replacement.png', 'image/png'), replaceKey = { 'Idempotency-Key': 'cert-replace-once' };
  const updated = await f.replaceFile(initial, replacement, f.clients.supervisor, replaceKey);
  const current = await f.patch(updated, { title: 'new metadata after success' }), before = f.state();
  assert.deepEqual(await f.upload(payload, f.admin, uploadKey), initial);
  assert.deepEqual(await f.replaceFile(initial, replacement, f.clients.supervisor, replaceKey), updated);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), { ...payload, title: 'different' }, uploadKey)).status, 409);
  assert.equal((await f.request(f.clients.supervisor, 'POST', route(initial, '/replace-file'), { version: 1, ...filePayload() }, replaceKey)).status, 409);
  assert.equal((await f.request(f.admin, 'POST', route(initial, '/replace-file'), { version: 1, ...replacement })).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(f.admin, 'PATCH', route(initial), { version: 1, note: 'stale' })).body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(f.state(), before);
  // Explicit synthetic current-parent corruption; immutable saved versions are untouched.
  f.app.db.prepare('UPDATE records SET entity=? WHERE id=?').run('employees', f.certA.id);
  const invalidBefore = f.state();
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), payload, uploadKey)).status, 404);
  assert.equal((await f.request(f.clients.supervisor, 'POST', route(initial, '/replace-file'), { version: 1, ...replacement }, replaceKey)).status, 404);
  assert.deepEqual(f.state(), invalidBefore);
  f.app.db.prepare('UPDATE records SET entity=? WHERE id=?').run(CERT, f.certA.id);
  const restoredBefore = f.state();
  assert.equal((await f.upload(payload, f.admin, uploadKey)).version, 1);
  assert.equal((await f.replaceFile(initial, replacement, f.clients.supervisor, replaceKey)).version, 2);
  assert.equal((await f.request(f.admin, 'GET', route(current))).body.item.version, 3); assert.deepEqual(f.state(), restoredBefore);
});

test('storage failures roll back metadata, versions, files, audit and idempotency and all six immutable triggers remain enforced', async t => {
  const f = await fixture(t), item = await f.upload();
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 11);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 6);
  f.app.db.exec("CREATE TRIGGER synthetic_reject_cert_file BEFORE INSERT ON certification_attachment_files BEGIN SELECT RAISE(ABORT,'Synthetic certificate storage failure'); END;");
  const attempts = [[route(null, '/upload'), f.payload(), 'rollback-cert-upload'], [route(item, '/replace-file'), { version: item.version, ...filePayload(PNG_BYTES, 'new.png', 'image/png') }, 'rollback-cert-replace']];
  for (const [url, data, key] of attempts) {
    const before = f.state().tables;
    assert.equal((await f.request(f.admin, 'POST', url, data, { 'Idempotency-Key': key })).status, 500);
    assert.deepEqual(f.state().tables, before, 'rolled-back attempts leave no durable rows or modified records');
    assert.equal((await f.request(f.admin, 'GET', route(item))).body.item.version, 1);
  }
  f.app.db.exec('DROP TRIGGER synthetic_reject_cert_file');
  const recovered = await f.replaceFile(item, filePayload(PNG_BYTES, 'new.png', 'image/png'), f.admin, { 'Idempotency-Key': 'rollback-cert-replace' });
  assert.equal(recovered.version, 2); assert.equal(f.counts().certification_attachment_files, 2);
  const before = f.state().tables;
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    // A case-file row is inserted below so both original case triggers execute too.
    if (table === 'attachment_files') continue;
    assert.throws(() => f.app.db.exec('UPDATE ' + table + ' SET created_at=created_at'), /immutable/);
    assert.throws(() => f.app.db.exec('DELETE FROM ' + table), /immutable/);
  }
  assert.deepEqual(f.state().tables, before);
  const file = { fileId: id(), fileName: 'synthetic.pdf', mimeType: 'application/pdf', sizeBytes: 0, sha256: digest(Buffer.alloc(0)), bytes: Buffer.alloc(0) };
  assert.throws(() => insertCertificationAttachmentFile(f.app.db, { orgId: f.admin.org }, recovered, file), /CHECK constraint/);
  assert.throws(() => insertCertificationAttachmentFile(f.app.db, { orgId: f.admin.org }, recovered, { ...file, fileId: id(), sizeBytes: 1 }), /CHECK constraint/);
});

test('authorized certificate filters precede 25-row pagination and 28-version comparisons retain the exact previous page', async t => {
  const f = await fixture(t), items = [];
  for (let i = 0; i < 28; i++) items.push(await f.upload(f.payload({ title: '合成附件分頁 ' + i, status: i < 25 ? 'active' : 'inactive' })));
  await f.upload(f.payload({ certificationId: f.certB.id, title: '合成附件分頁別人' }));
  await f.upload(f.payload({ certificationId: f.certA2.id, title: '合成附件分頁別張證照' }));
  const query = '?certificationId=' + f.certA.id + '&q=' + encodeURIComponent('合成附件分頁');
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    const first = (await f.request(client, 'GET', route(null, query))).body, second = (await f.request(client, 'GET', route(null, query + '&page=2'))).body;
    assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 28);
    assert.equal((await f.request(client, 'GET', route(null, query + '&employeeId=' + f.employeeA.id + '&status=inactive'))).body.total, 3);
    assert.equal((await f.request(client, 'GET', route(null, query + '&employeeId=' + f.employeeB.id))).body.total, 0);
  }
  for (const value of ['', 'invalid', '1234', f.certA.id.toUpperCase(), f.certA.id + '&certificationId=' + f.certA.id]) assert.equal((await f.request(f.admin, 'GET', route(null, '?certificationId=' + value))).status, 422);
  for (const value of [id(), f.employeeA.id]) assert.equal((await f.request(f.admin, 'GET', route(null, '?certificationId=' + value))).status, 404);
  assert.equal((await f.request(f.clients.carerB, 'GET', route(null, '?certificationId=' + f.certA.id))).status, 404);
  // This new reference filter does not alter the old case-attachment query semantics.
  assert.equal((await f.request(f.admin, 'GET', '/api/case-attachments?certificationId=invalid')).status, 200);
  let item = items[0];
  for (let version = 2; version <= 28; version++) item = await f.patch(item, { note: '合成歷程 ' + version }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  const page1 = (await f.request(f.clients.carerA, 'GET', route(item, '/history?compare=previous'))).body;
  const page2 = (await f.request(f.clients.carerA, 'GET', route(item, '/history?compare=previous&page=2'))).body;
  assert.equal(page1.total, 28); assert.equal(page1.items.length, 25); assert.equal(page2.items.length, 3);
  assert.equal(page1.items.at(-1).version, 4); assert.equal(page1.items.at(-1).comparison.previousVersion, 3);
  assert.deepEqual(page1.items.at(-1).comparison.previousSnapshot, page2.items[0].snapshot);
  assert.deepEqual(page1.items[0].actor, actor(f.clients.supervisor));
  const raw = (await f.request(f.admin, 'GET', route(item, '/history?pageSize=100'))).body;
  assert.equal(raw.items.length, 28); assert.ok(raw.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  assert.ok(!JSON.stringify(raw).includes('fileId'));
  for (const compare of ['', 'next', 'previous&compare=previous']) assert.equal((await f.request(f.admin, 'GET', route(item, '/history?compare=' + compare))).status, 422);
  for (const value of ['', '0', '-1', '1.1', '01', '1e0', '9007199254740992', '1&recordVersion=1']) assert.equal((await f.request(f.admin, 'GET', route(item, '/download?recordVersion=' + value))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', route(item, '/download?recordVersion=999'))).status, 404);
  assert.deepEqual(f.state(), before);
});

test('history hides different certificate or employee snapshots before exact comparison for every permitted role', async t => {
  const f = await fixture(t), item = await f.upload();
  f.addVersion(item, 2, { certificationId: f.certA2.id, title: 'PRIVATE OTHER CERTIFICATE SAME EMPLOYEE' });
  f.addVersion(item, 3);
  f.addVersion(item, 4, { employeeId: f.employeeB.id, title: 'PRIVATE OTHER EMPLOYEE' });
  f.addVersion(item, 5);
  f.app.db.prepare('UPDATE records SET version=5 WHERE id=?').run(item.id);
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    const comparison = (await f.request(client, 'GET', route(item, '/history?compare=previous'))).body;
    const raw = (await f.request(client, 'GET', route(item, '/history'))).body;
    assert.deepEqual(raw.items.map(row => row.version), [5, 3, 1]); assert.deepEqual(comparison.items.map(row => row.version), [5, 3, 1]);
    assert.equal(comparison.total, 3); assert.ok(!JSON.stringify(comparison).includes('PRIVATE'));
    assert.ok(!JSON.stringify(comparison).includes('fileId'));
    for (const row of comparison.items.slice(0, 2)) { assert.equal(row.actor, null); assert.deepEqual(row.comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); }
    for (const version of [2, 4]) assert.equal((await f.request(client, 'GET', route(item, '/download?recordVersion=' + version))).status, 404);
    assert.deepEqual((await f.request(client, 'GET', route(item, '/download'))).bytes, PDF_BYTES);
  }
  assert.deepEqual(f.state(), before);
});

test('downloads validate complete immutable tuples, saved metadata, hashes and signatures without falling back to other versions', async t => {
  const f = await fixture(t), item = await f.upload(), other = await f.upload(), base = f.stored(item);
  const foreignOrg = await f.create('organizations', { name: '合成檔案外機構' });
  let version = 2;
  const bad = [];
  for (const changes of [
    { fileId: f.stored(other).fileId }, { fileId: id() }, { fileName: 'wrong.pdf' }, { mimeType: 'image/png' }, { sizeBytes: 1 }, { sha256: '0'.repeat(64) },
    { id: other.id }, { orgId: foreignOrg.id }, { version: 12345 }, { certificationId: f.certA2.id }, { employeeId: f.employeeB.id },
  ]) { f.addVersion(item, version, changes); bad.push(version++); }
  for (const [scope, fields] of [
    [{ orgId: foreignOrg.id }, {}], [{ orgId: f.admin.org }, { id: other.id }], [{ orgId: f.admin.org }, { certificationId: f.certA2.id }], [{ orgId: f.admin.org }, { employeeId: f.employeeB.id }],
  ]) {
    const file = { ...base, fileId: id(), bytes: PDF_BYTES };
    insertCertificationAttachmentFile(f.app.db, scope, { ...item, ...fields }, file);
    f.addVersion(item, version, { fileId: file.fileId }); bad.push(version++);
  }
  for (const [bytes, hash] of [[PDF_BYTES, '0'.repeat(64)], [Buffer.alloc(PDF_BYTES.length, 32), null]]) {
    const file = { ...base, fileId: id(), bytes, sha256: hash || digest(bytes) };
    insertCertificationAttachmentFile(f.app.db, { orgId: f.admin.org }, item, file);
    f.addVersion(item, version, { fileId: file.fileId, sha256: file.sha256 }); bad.push(version++);
  }
  f.addVersion(item, version, {}, { entity: 'employee-training' }); bad.push(version++);
  f.addVersion(item, version, {}, { orgId: foreignOrg.id }); bad.push(version++);
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    for (const number of bad) assert.equal((await f.request(client, 'GET', route(item, '/download?recordVersion=' + number))).status, 404, 'corrupt metadata version ' + number);
    assert.deepEqual((await f.request(client, 'GET', route(item, '/download?recordVersion=1'))).bytes, PDF_BYTES);
    assert.deepEqual((await f.request(client, 'GET', route(item, '/download'))).bytes, PDF_BYTES);
    assert.equal((await f.request(client, 'GET', '/api/certification-attachment-files/' + base.fileId)).status, 404);
  }
  assert.deepEqual(f.state(), before);
});

test('certificate attachment actors accept only exact create/update identities and baseline, conflict, missing or wrong events stay unknown', async t => {
  const f = await fixture(t), seed = await f.upload(), item = f.imported(f.stored(seed), 6);
  for (let version = 1; version <= 6; version++) f.addVersion(item, version);
  f.auditEvent(item, { userId: f.clients.supervisor.user.id, detail: { version: 2 } });
  f.auditEvent(item, { userId: f.clients.supervisor.user.id, detail: { version: 2 } });
  for (const action of ['service.review', 'shift.complete', 'certification.upload']) f.auditEvent(item, { action, detail: { version: 3 } });
  f.auditEvent(item, { userId: f.admin.user.id, detail: { version: 4 } }); f.auditEvent(item, { userId: f.clients.supervisor.user.id, detail: { version: 4 } });
  const foreignOrg = await f.create('organizations', { name: '合成錯誤稽核機構' });
  for (const changes of [{ orgId: foreignOrg.id }, { entity: CERT }, { recordId: seed.id }, { detail: { version: '5' } }, { detail: { version: 500 } }]) f.auditEvent(item, { detail: { version: 5 }, ...changes });
  f.auditEvent(item, { userId: id(), detail: { version: 6 } });
  const before = f.state();
  const rows = (await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body.items;
  assert.deepEqual(rows.map(row => row.actor), [null, null, null, null, actor(f.clients.supervisor), null]);
  assert.ok(rows.slice(0, 5).every(row => row.comparison.status === 'available'));
  assert.equal(rows.at(-1).comparison.status, 'initial');
  assert.ok(!JSON.stringify(rows).includes('fileId'));
  assert.deepEqual(f.state(), before);
  const empty = f.imported(f.stored(seed), 4), emptyBefore = f.state();
  const result = (await f.request(f.clients.carerA, 'GET', route(empty, '/history?compare=previous'))).body;
  assert.equal(result.total, 0); assert.deepEqual(result.items, []); assert.deepEqual(f.state(), emptyBefore);
});

test('all certification GETs are pure across eleven tables and preserve parent histories, old case files and approved billing', async t => {
  const f = await fixture(t);
  const caseItem = await f.create('cases', { name: '合成附件相容個案', caseNo: 'TEST-CA-CASE', contactName: '原合成聯絡人', contactPhone: 'TEST-PHONE', primaryCarer: '原合成照顧者' });
  const service = await f.create('service-items', { code: 'TEST-CA-SERVICE', name: '合成試算服務', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await f.create('shifts', { caseId: caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:00', actualEnd: '09:47', services, status: 'submitted' }, f.clients.carerA);
  const reviewed = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成實際核閱' });
  assert.equal(reviewed.status, 200); const approved = f.stored(record);
  const reportKinds = ['cases', 'shifts', 'services', 'fees', 'payroll'];
  const reports = await Promise.all(reportKinds.map(async kind => (await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body));
  assert.equal(reports[3].totals.amountCents, 30000); assert.equal(reports[4].totals.amountCents, 18800);
  await f.edit('service-items', service, { unitPriceCents: 999999 }); await f.edit('employees', f.employeeA, { hourlyRateCents: 888888 });
  const caseUpload = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: caseItem.id, title: '原個案附件', ...filePayload() });
  assert.equal(caseUpload.status, 201); const oldAttachment = caseUpload.body.item;
  const parents = [['employees', f.employeeA], [CERT, f.certA], ['cases', caseItem], ['case-attachments', oldAttachment], ['service-records', record], ['shifts', shift]];
  const parentHistories = await Promise.all(parents.map(async ([entity, item]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history')).body));
  let attachment = await f.upload(); attachment = await f.patch(attachment, { note: '不變更父項或核閱結果' }); attachment = await f.replaceFile(attachment);
  assert.deepEqual(f.stored(record), approved);
  assert.deepEqual(await Promise.all(reportKinds.map(async kind => (await f.request(f.admin, 'GET', '/api/reports/' + kind + '?month=2026-10')).body)), reports);
  assert.deepEqual(await Promise.all(parents.map(async ([entity, item]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history')).body)), parentHistories);
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    for (const suffix of ['', '/history', '/history?compare=previous', '/download', '/download?recordVersion=1', '/download?recordVersion=2']) assert.equal((await f.request(client, 'GET', route(attachment, suffix))).status, 200);
    assert.equal((await f.request(client, 'GET', route(null, '?certificationId=' + f.certA.id))).status, 200);
    for (const suffix of ['', '/history?compare=previous', '/download?recordVersion=1']) assert.equal((await f.request(client, 'GET', '/api/case-attachments/' + oldAttachment.id + suffix)).status, 200);
    const recordRead = await f.request(client, 'GET', '/api/service-records/' + record.id);
    assert.equal(Object.hasOwn(recordRead.body.item, 'billingSnapshot'), client === f.admin);
  }
  for (const suffix of ['', '/history', '/history?compare=previous', '/download']) assert.equal((await f.request(f.clients.finance, 'GET', route(attachment, suffix))).status, 403);
  for (const kind of ['fees', 'payroll']) {
    assert.equal((await f.request(f.clients.finance, 'GET', '/api/reports/' + kind)).status, 200);
    assert.equal((await f.request(f.clients.finance, 'GET', '/api/reports/' + kind + '.csv')).status, 200);
  }
  const oldDownload = await f.request(f.clients.finance, 'GET', '/api/case-attachments/' + oldAttachment.id + '/download');
  assert.equal(oldDownload.status, 200); assert.deepEqual(oldDownload.bytes, PDF_BYTES); assert.match(oldDownload.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request(f.admin, 'PATCH', '/api/service-records/' + record.id, { version: 2, note: 'locked' })).body.error.code, 'RECORD_LOCKED');
  assert.equal((await f.request(f.admin, 'PATCH', '/api/shifts/' + shift.id, { version: 2, employeeId: f.employeeB.id })).body.error.code, 'SHIFT_HAS_RECORD');
  assert.deepEqual(f.state(), before);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    assert.throws(() => f.app.db.exec('UPDATE ' + table + ' SET created_at=created_at'), /immutable/);
    assert.throws(() => f.app.db.exec('DELETE FROM ' + table), /immutable/);
  }
  assert.deepEqual(f.state().tables, before.tables);
});

test('temporary legacy schema upgrades preserve old SQL and rows and new immutable files survive database reopen', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'suiyue-certification-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, path.join(directory, 'synthetic.sqlite'));
  const caseItem = await f.create('cases', { name: '合成舊 schema 個案', caseNo: 'TEST-CA-OLD-SCHEMA' });
  const old = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: caseItem.id, title: '合成舊檔案', ...filePayload() }); assert.equal(old.status, 201);
  const oldTables = tables.filter(table => table !== 'certification_attachment_files');
  const oldRows = Object.fromEntries(oldTables.map(table => [table, f.app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const oldSql = f.app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'certification_attachment_files%' ORDER BY type,name").all();
  // Only this synthetic temporary database is shaped like the prior ten-table schema.
  f.app.db.exec('DROP TABLE certification_attachment_files');
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 4);
  await f.reopen();
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 11);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 6);
  assert.deepEqual(f.app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'certification_attachment_files%' ORDER BY type,name").all(), oldSql);
  assert.deepEqual(Object.fromEntries(oldTables.map(table => [table, f.app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])), oldRows);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/case-attachments/' + old.body.item.id + '/download')).bytes, PDF_BYTES);
  const parents = [f.stored(f.certA), f.stored(f.employeeA)];
  let item = await f.upload(f.payload(), f.admin, { 'Idempotency-Key': 'persistent-cert-upload' });
  item = await f.replaceFile(item); item = await f.patch(item, { title: '重開前保存的 metadata' });
  const saved = f.state().tables;
  await f.reopen();
  assert.deepEqual(f.state().tables, saved);
  assert.deepEqual([f.stored(f.certA), f.stored(f.employeeA)], parents);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item, '/download?recordVersion=1'))).bytes, PDF_BYTES);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item, '/download?recordVersion=2'))).bytes, PNG_BYTES);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item, '/download'))).bytes, PNG_BYTES);
  assert.equal((await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body.total, 3);
  assert.equal((await f.upload(f.payload(), f.admin, { 'Idempotency-Key': 'persistent-cert-upload' })).version, 1);
  assert.deepEqual(f.state().tables, saved);
});
