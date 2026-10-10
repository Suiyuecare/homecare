import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_BODY_BYTES } from '../src/server/attachments.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const ENTITY = 'case-attachments';
const route = (item, suffix = '') => '/api/' + ENTITY + (item ? '/' + item.id : '') + suffix;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, dbPath = ':memory:') {
  let app = createApp({ dbPath, port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        Origin: base,
        ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : null, bytes, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', {
    name: '合成附件管理員', email: 'attachments-admin@example.test', password: 'attachments-test-password', organizationName: '合成附件機構甲',
  });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成居服員', employeeNo: 'TEST-ATTACHMENT-01' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = role + '@attachments.example.test';
    await create('users', { name: '合成' + role, email, password: 'attachments-test-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password: 'attachments-test-password' });
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成附件可見個案', caseNo: 'TEST-ATTACHMENT-A', contactName: '原合成聯絡人', contactPhone: 'TEST-PHONE', primaryCarer: '原合成照顧者' });
  const caseB = await create('cases', { name: '合成其他個案', caseNo: 'TEST-ATTACHMENT-B' });
  const payload = (overrides = {}) => ({ caseId: caseA.id, title: '合成附件', ...filePayload(), ...overrides });
  async function upload(data = payload(), client = admin, headers = {}) {
    const result = await request(client, 'POST', route(null, '/upload'), data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(item, data, client = admin) {
    const result = await request(client, 'PATCH', route(item), { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  async function replaceFile(item, data = filePayload(PNG_BYTES, '合成新版.png', 'image/png'), client = admin, headers = {}) {
    const result = await request(client, 'POST', route(item, '/replace-file'), { version: item.version, ...data }, headers);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  async function assign() {
    const service = await create('service-items', { code: 'TEST-ATTACHMENT', name: '合成服務', minutes: 60, unitPriceCents: 10000 });
    const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  }
  function counts() { return Object.fromEntries(['records', 'record_versions', 'attachment_files', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n])); }
  return { get app() { return app; }, request, create, admin, clients, caseA, caseB, payload, upload, patch, replaceFile, assign, counts, async reopen() { await app.close(); app = createApp({ dbPath, port: 0 }); base = await app.listen(); } };
}

test('attachment upload, metadata and replacement preserve exact historical files, omit internal IDs and do not alter cases', async t => {
  const f = await fixture(t); await f.assign();
  const caseHistory = (await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id + '/history')).body;
  let item = await f.upload(f.payload({ title: ' 合成標題 ', category: ' care ', note: ' 合成備註 ', fileName: ' 合成"文件.PDF ' }));
  assert.equal(item.title, '合成標題'); assert.equal(item.category, 'care'); assert.equal(item.note, '合成備註');
  assert.equal(item.fileName, '合成"文件.PDF'); assert.equal(item.sizeBytes, PDF_BYTES.length); assert.equal(item.sha256, digest(PDF_BYTES));
  assert.ok(!Object.hasOwn(item, 'fileId'));
  const internal = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
  assert.ok(internal.fileId);
  item = await f.patch(item, { title: '合成第二版描述', caseId: f.caseA.id }, f.clients.supervisor);
  assert.equal(f.counts().attachment_files, 1); assert.equal(item.version, 2);
  item = await f.replaceFile(item, undefined, f.clients.supervisor);
  assert.equal(item.version, 3); assert.equal(item.mimeType, 'image/png'); assert.equal(f.counts().attachment_files, 2);
  item = await f.patch(item, { status: 'inactive' });
  const before = f.counts(), changes = f.app.db.prepare('SELECT total_changes() AS n').get().n;
  for (const client of Object.values(f.clients)) {
    for (const url of [route(), route(item), route(item, '/history?compare=previous')]) {
      const result = await f.request(client, 'GET', url);
      assert.equal(result.status, 200); assert.ok(!JSON.stringify(result.body).includes('fileId')); assert.ok(!JSON.stringify(result.body).includes('contentBase64'));
    }
    for (const [version, bytes, mime] of [[1, PDF_BYTES, 'application/pdf'], [2, PDF_BYTES, 'application/pdf'], [3, PNG_BYTES, 'image/png'], [4, PNG_BYTES, 'image/png'], [null, PNG_BYTES, 'image/png']]) {
      const result = await f.request(client, 'GET', route(item, '/download' + (version ? '?recordVersion=' + version : '')));
      assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.equal(result.headers.get('content-type'), mime);
      assert.equal(Number(result.headers.get('content-length')), bytes.length); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.match(result.headers.get('content-disposition'), /^attachment; filename="attachment\.(pdf|png)"; filename\*=UTF-8''/);
      if (version === 1) assert.ok(result.headers.get('content-disposition').includes('%22'));
    }
  }
  const history = (await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body;
  assert.equal(history.items[1].actor.id, f.clients.supervisor.user.id); assert.equal(history.items[1].comparison.previousVersion, 2);
  assert.equal(history.items[1].comparison.previousSnapshot.sha256, digest(PDF_BYTES));
  assert.equal(history.items.at(-1).actor.id, f.admin.user.id);
  assert.deepEqual(f.counts(), before); assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id)).body.item, f.caseA);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id + '/history')).body, caseHistory);
});

test('attachment metadata validates fields and immutable case ownership without allowing upload bypass', async t => {
  const f = await fixture(t), item = await f.upload();
  const before = f.counts();
  const plain = await f.request(f.admin, 'POST', route(), f.payload());
  assert.equal(plain.status, 405); assert.equal(plain.body.error.code, 'UPLOAD_REQUIRED');
  for (const data of [{ title: '' }, { title: ' \t ' }, { title: 'x'.repeat(201) }, { title: 12 }, { category: 'medical' }, { status: 'deleted' }, { note: 'x'.repeat(10001) }]) {
    assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(data))).status, 422);
  }
  for (const key of ['fileId', 'fileName', 'mimeType', 'sizeBytes', 'sha256', 'contentBase64']) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: 1, [key]: 'tamper' });
    assert.equal(result.status, 422); assert.equal(result.body.error.code, 'UNKNOWN_FIELD');
  }
  for (const caseId of [f.caseB.id, id(), '']) {
    const result = await f.request(f.admin, 'PATCH', route(item), { version: 1, caseId });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CASE_IMMUTABLE');
  }
  assert.equal((await f.request(f.admin, 'POST', route(item, '/replace-file'), { ...filePayload(), version: 1, title: 'cannot change metadata here' })).status, 422);
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ caseId: id() }))).status, 422);
  assert.deepEqual(f.counts(), before);
  for (const status of ['paused', 'closed']) {
    const caseItem = await f.create('cases', { name: '合成非啟用個案', caseNo: 'TEST-' + status, status });
    assert.ok((await f.upload(f.payload({ caseId: caseItem.id, title: '字'.repeat(200), note: '字'.repeat(10000) }))).id);
  }
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404);
});

test('attachment file validation enforces canonical base64, names, types, signatures and exact size/body limits', async t => {
  const f = await fixture(t);
  const before = f.counts();
  for (const fields of [
    { contentBase64: '' }, { contentBase64: 'AB==' }, { contentBase64: 'A===' }, { contentBase64: 'AA==' }, { contentBase64: null },
    { contentBase64: PDF_BYTES.toString('base64') + '\n' }, { contentBase64: 'data:application/pdf;base64,' + PDF_BYTES.toString('base64') },
    { contentBase64: PDF_BYTES.toString('base64').replace(/=$/, '') }, { contentBase64: '%%%%' },
    { fileName: '' }, { fileName: 'x'.repeat(181) + '.pdf' }, { fileName: '../test.pdf' }, { fileName: 'a\\test.pdf' }, { fileName: 'a\u0000.pdf' },
    { fileName: 'a\r\nHeader: injected.pdf' }, { fileName: 'a\u007f.pdf' }, { fileName: 'a\ud800.pdf' }, { fileName: 'a.html' },
    { mimeType: 'text/html' }, { fileName: 'a.png' }, { mimeType: 'image/png' }, { contentBase64: Buffer.from('NOT PDF').toString('base64') },
    filePayload(PNG_BYTES, 'a.jpg', 'image/jpeg'),
  ]) {
    const result = await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(fields));
    assert.equal(result.status, 422, JSON.stringify(fields)); assert.ok(result.body.error.fields.file);
  }
  assert.deepEqual(f.counts(), before);
  const maximum = Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES, 32); PDF_BYTES.copy(maximum);
  const large = await f.upload(f.payload(filePayload(maximum, 'max.pdf')));
  assert.equal(large.sizeBytes, MAX_ATTACHMENT_FILE_BYTES);
  const excessive = Buffer.concat([maximum, Buffer.from('x')]);
  const tooLarge = await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(filePayload(excessive)));
  assert.equal(tooLarge.status, 413); assert.ok(tooLarge.body.error.fields.file);
  const bodyTooLarge = await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ contentBase64: 'A'.repeat(MAX_ATTACHMENT_BODY_BYTES) }));
  assert.equal(bodyTooLarge.status, 413); assert.equal(bodyTooLarge.body.error.code, 'BODY_TOO_LARGE'); assert.ok(bodyTooLarge.body.error.fields.file);
  const normalBody = await f.request(f.admin, 'PATCH', '/api/cases/' + f.caseA.id, { version: 1, note: 'x'.repeat(131072) });
  assert.equal(normalBody.status, 413); assert.equal(normalBody.body.error.code, 'BODY_TOO_LARGE');
  const replaceBody = await f.request(f.admin, 'POST', route(large, '/replace-file'), { version: 1, ...filePayload(maximum) });
  assert.equal(replaceBody.status, 200);
  assert.ok((await f.upload(f.payload(filePayload(PNG_BYTES, 'VALID.PNG', 'image/png')))).id);
  // The contract checks signatures only; this synthetic marker is not a complete decoded JPEG.
  assert.ok((await f.upload(f.payload(filePayload(Buffer.from([255, 216, 255, 217]), 'signature.JPEG', 'image/jpeg')))).id);
});

test('attachment transactions roll back records, files, versions and idempotency together; retries and stale versions do not duplicate', async t => {
  const f = await fixture(t);
  const data = f.payload(), key = { 'Idempotency-Key': 'attachment-upload-once' };
  const item = await f.upload(data, f.admin, key);
  const afterUpload = f.counts();
  assert.equal((await f.upload(data, f.admin, key)).id, item.id); assert.deepEqual(f.counts(), afterUpload);
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), { ...data, title: 'different' }, key)).status, 409);
  const replacement = filePayload(PNG_BYTES, 'changed.png', 'image/png'), replaceKey = { 'Idempotency-Key': 'attachment-replace-once' };
  const updated = await f.replaceFile(item, replacement, f.clients.supervisor, replaceKey), afterReplace = f.counts();
  assert.equal((await f.replaceFile(item, replacement, f.clients.supervisor, replaceKey)).version, updated.version);
  assert.deepEqual(f.counts(), afterReplace);
  assert.equal((await f.request(f.admin, 'POST', route(item, '/replace-file'), { version: 1, ...filePayload() })).status, 409);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, title: 'stale' })).status, 409);
  assert.deepEqual(f.counts(), afterReplace);
  f.app.db.exec("CREATE TRIGGER test_reject_attachment BEFORE INSERT ON attachment_files BEGIN SELECT RAISE(ABORT,'Synthetic forced storage failure'); END;");
  for (const [url, body, idem] of [
    [route(null, '/upload'), f.payload(), 'rollback-upload'],
    [route(updated, '/replace-file'), { version: updated.version, ...filePayload() }, 'rollback-replace'],
  ]) {
    const before = f.counts();
    const result = await f.request(f.admin, 'POST', url, body, { 'Idempotency-Key': idem });
    assert.equal(result.status, 500); assert.deepEqual(f.counts(), before);
    assert.equal((await f.request(f.admin, 'GET', route(updated))).body.item.version, updated.version);
  }
  f.app.db.exec('DROP TRIGGER test_reject_attachment');
  const recovered = await f.replaceFile(updated, filePayload(), f.admin, { 'Idempotency-Key': 'rollback-replace' });
  assert.equal(recovered.version, 3);
  assert.throws(() => f.app.db.prepare('UPDATE attachment_files SET file_name=? WHERE attachment_id=?').run('tampered.pdf', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM attachment_files WHERE attachment_id=?').run(item.id), /immutable/);
});

test('attachment roles and organization/case authorization protect every metadata, history, upload and download path', async t => {
  const f = await fixture(t); await f.assign();
  const mine = await f.upload(f.payload({ status: 'inactive' })), hidden = await f.upload(f.payload({ caseId: f.caseB.id, title: 'PRIVATE-OTHER-CASE' }));
  const organization = await f.create('organizations', { name: '合成附件機構乙' }), otherOrg = { ...f.admin, org: organization.id };
  const foreignCase = await f.create('cases', { name: '跨機構合成個案', caseNo: 'TEST-FOREIGN' }, otherOrg);
  const foreign = await f.upload(f.payload({ caseId: foreignCase.id }), otherOrg);
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload({ caseId: foreignCase.id }))).status, 422);
  const before = f.counts();
  for (const client of [f.clients.caregiver, f.clients.finance]) {
    assert.equal((await f.request(client, 'GET', route(mine, '/download'))).status, 200);
    assert.equal((await f.request(client, 'POST', route(null, '/upload'), {})).status, 403);
    assert.equal((await f.request(client, 'POST', route(), {})).status, 403);
    for (const item of [mine, hidden, foreign, { id: id() }]) {
      assert.equal((await f.request(client, 'PATCH', route(item), {})).status, 403);
      assert.equal((await f.request(client, 'POST', route(item, '/replace-file'), {})).status, 403);
    }
  }
  assert.equal((await f.request(f.clients.finance, 'GET', route(hidden, '/download?recordVersion=1'))).status, 200);
  assert.equal((await f.request(f.clients.caregiver, 'GET', route(null, '?q=PRIVATE'))).body.total, 0);
  assert.equal((await f.request(f.clients.caregiver, 'GET', route())).body.total, 1);
  for (const suffix of ['', '/history?compare=previous', '/download', '/download?recordVersion=1']) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', route(hidden, suffix))).status, 404);
    assert.equal((await f.request(f.admin, 'GET', route(foreign, suffix))).status, 404);
    assert.equal((await f.request(otherOrg, 'GET', route(mine, suffix))).status, 404);
  }
  assert.equal((await f.request(f.admin, 'POST', route(null, '/upload'), f.payload(), { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request(f.admin, 'POST', route(mine, '/replace-file'), { version: 1, ...filePayload() }, { 'X-CSRF-Token': '' })).status, 403);
  assert.deepEqual(f.counts(), before);
});

test('attachment filters paginate after scope and category validation while exact recordVersion syntax never falls back', async t => {
  const f = await fixture(t); await f.assign();
  const items = [];
  for (let i = 1; i <= 28; i++) items.push(await f.upload(f.payload({ title: '合成附件分頁 ' + i, category: i <= 26 ? 'care' : 'other', status: i <= 25 ? 'active' : 'inactive' })));
  await f.upload(f.payload({ caseId: f.caseB.id, title: '合成附件分頁他案' }));
  const query = '?caseId=' + f.caseA.id + '&q=' + encodeURIComponent('合成附件分頁');
  const page1 = await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=1')), page2 = await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=2'));
  assert.equal(page1.body.total, 28); assert.equal(page1.body.items.length, 25); assert.equal(page2.body.items.length, 3);
  assert.equal(new Set([...page1.body.items, ...page2.body.items].map(item => item.id)).size, 28);
  assert.equal((await f.request(f.admin, 'GET', route(null, query + '&category=care&status=inactive'))).body.total, 1);
  for (const category of ['', 'invalid', 'care&category=care']) assert.equal((await f.request(f.admin, 'GET', route(null, '?category=' + category))).status, 422);
  for (const version of ['', '0', '-1', '1.1', '01', '1e0', '9007199254740992', '1&recordVersion=1']) {
    const result = await f.request(f.admin, 'GET', route(items[0], '/download?recordVersion=' + version));
    assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_RECORD_VERSION');
  }
  assert.equal((await f.request(f.admin, 'GET', route(items[0], '/download?recordVersion=999'))).status, 404);
});

test('attachment history/download reject other-case snapshots, forged blob references and metadata; comparisons use exact visible predecessors', async t => {
  const f = await fixture(t); await f.assign();
  const original = await f.upload(), other = await f.upload(f.payload({ caseId: f.caseB.id }));
  const base = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(original.id).data);
  const otherData = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(other.id).data);
  const time = now();
  function addVersion(version, changes) {
    const snapshot = { ...base, id: original.id, orgId: f.admin.org, version, createdAt: original.createdAt, updatedAt: time, ...changes };
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, ENTITY, original.id, version, JSON.stringify(snapshot), time, 'baseline');
  }
  addVersion(2, { caseId: f.caseB.id, title: 'PRIVATE-HIDDEN-HISTORY' });
  addVersion(3, {});
  f.app.db.prepare('UPDATE records SET version=3,updated_at=? WHERE id=?').run(time, original.id);
  for (const client of Object.values(f.clients)) {
    const history = await f.request(client, 'GET', route(original, '/history?compare=previous'));
    assert.deepEqual(history.body.items.map(row => row.version), [3, 1]);
    assert.deepEqual(history.body.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
    assert.equal(history.body.items[0].actor, null); assert.ok(!JSON.stringify(history.body).includes('PRIVATE-HIDDEN-HISTORY'));
    assert.equal((await f.request(client, 'GET', route(original, '/download?recordVersion=2'))).status, 404);
  }
  const corruptions = [
    { fileId: otherData.fileId }, { fileName: 'wrong.pdf' }, { mimeType: 'image/png' }, { sizeBytes: 1 }, { sha256: '0'.repeat(64) },
    { fileId: id() }, { orgId: id() }, { id: other.id }, { version: 12345 },
  ];
  for (const [index, changes] of corruptions.entries()) {
    const version = index + 4; addVersion(version, changes);
    assert.equal((await f.request(f.admin, 'GET', route(original, '/download?recordVersion=' + version))).status, 404, JSON.stringify(changes));
  }
  const sameCase = await f.upload();
  const sameData = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(sameCase.id).data);
  addVersion(20, { ...sameData });
  assert.equal((await f.request(f.admin, 'GET', route(original, '/download?recordVersion=20'))).status, 404, 'another attachment in the same case cannot supply its BLOB');
  assert.deepEqual((await f.request(f.admin, 'GET', route(original, '/download'))).bytes, PDF_BYTES);
});

test('attachment immutable BLOBs and exact-version downloads survive closing and reopening a temporary database', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'suiyue-attachments-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, path.join(directory, 'test.sqlite'));
  let item = await f.upload();
  item = await f.replaceFile(item);
  const before = f.counts();
  await f.reopen();
  assert.deepEqual(f.counts(), before);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item, '/download?recordVersion=1'))).bytes, PDF_BYTES);
  assert.deepEqual((await f.request(f.admin, 'GET', route(item, '/download'))).bytes, PNG_BYTES);
  assert.equal((await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body.total, 2);
});
