import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { createCustomFormPackage, readCustomFormPackage, customFormPackageDraft } from '../public/data/custom-form-package.js';
import { confirmCustomFormSave } from '../public/data/custom-form-editor.js';
const password = 'synthetic-template-package-password';
const fields = [{ key: 'agreed', label: '合成是／否', type: 'boolean', required: true, options: [], visibleIf: null, groupId: '' },
  { key: 'detail', label: '合成條件長文', type: 'textarea', required: true, options: [], visibleIf: { field: 'agreed', equals: true }, groupId: '' }];
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); assert.notEqual(new URL(base).port, '4310'); t.after(() => app.close());
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '合成套件管理員', organizationName: '合成來源機構', email: 'template-package@example.test', password }) });
  assert.equal(setup.status, 201); const session = await setup.json(), orgId = session.organizations[0].id;
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken };
  const request = async (method, route, payload, expected = 200, custom = headers) => { const response = await fetch(base + '/api/' + route, { method, headers: custom, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) }); assert.equal(response.status, expected, await response.clone().text()); return response.json(); };
  const create = async (entity, payload, custom) => (await request('POST', entity, payload, 201, custom)).item;
  const template = await create('form-templates', { code: 'PACKAGE-ORIGIN', name: '合成套件來源', description: '  原說明\r\n末段  ', note: '  原備註\r\n末段  ', revision: 1, previousTemplateId: '', groups: [], fields, status: 'draft' });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT * FROM records ORDER BY id').all(), versions: app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(), audit: app.db.prepare('SELECT * FROM audit ORDER BY id').all() });
  return { app, base, session, orgId, headers, request, create, template, state };
}
test('Real HTTP portable package creates an explicit independent draft in target institution; no source mutation or identity/history migration', async t => {
  const f = await fixture(t), other = await f.create('organizations', { name: '合成目標機構' }), before = f.state();
  const source = (await f.request('GET', 'form-templates/' + f.template.id)).item, packageValue = await readCustomFormPackage(new TextEncoder().encode(JSON.stringify(await createCustomFormPackage(source, f.orgId))));
  assert.deepEqual(f.state(), before, 'Read and package validation are SQL observational');
  const draft = customFormPackageDraft(packageValue, { code: 'PACKAGE-TARGET', name: '合成獨立草稿' }), result = await f.request('POST', 'form-templates', draft, 201, { ...f.headers, 'X-Org-Id': other.id, 'Idempotency-Key': randomUUID() });
  const saved = confirmCustomFormSave(result, { entity: 'form-templates', orgId: other.id, payload: draft });
  assert.notEqual(saved.id, source.id); assert.equal(saved.orgId, other.id); assert.equal(saved.status, 'draft'); assert.equal(saved.version, 1); assert.equal(saved.revision, 1); assert.equal(saved.previousTemplateId, '');
  assert.deepEqual(saved.fields, source.fields); assert.equal(saved.note, source.note); assert.equal(saved.description, source.description);
  assert.deepEqual((await f.request('GET', 'form-templates/' + source.id)).item, source);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM records WHERE entity=?').get('form-records').n, 0);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM attachment_files').get().n, 0);
  const history = await f.request('GET', 'form-templates/' + saved.id + '/history?compare=previous', undefined, 200, { ...f.headers, 'X-Org-Id': other.id }); assert.equal(history.total, 1); assert.equal(history.items[0].actor.id, f.session.user.id);
});
test('Real HTTP template create uses existing stable idempotency and rejects duplicate code/CAS without overwriting original definitions', async t => {
  const f = await fixture(t), packageValue = await createCustomFormPackage(f.template, f.orgId), draft = customFormPackageDraft(packageValue, { code: 'PACKAGE-RETRY', name: '合成重送草稿' });
  const headers = { ...f.headers, 'Idempotency-Key': randomUUID() }, first = await f.request('POST', 'form-templates', draft, 201, headers), before = f.state();
  assert.deepEqual(await f.request('POST', 'form-templates', draft, 201, headers), first); assert.deepEqual(f.state(), before);
  await f.request('POST', 'form-templates', draft, 409, { ...f.headers, 'Idempotency-Key': randomUUID() }); await f.request('POST', 'form-templates', { ...draft, name: '不同' }, 409, headers);
  await f.request('PATCH', 'form-templates/' + first.item.id, { version: 99, note: '拒過期' }, 409); assert.deepEqual(f.state(), before);
});
test('Real four-role sessions retain template access matrix; revoked supervisor and foreign identities cannot transfer via existing endpoints', async t => {
  const f = await fixture(t), employee = await f.create('employees', { name: '合成居服員', employeeNo: 'PACKAGE-E' }), actors = {};
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    await f.create('users', { name: '合成套件' + role, email: role + '-package@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const response = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: role + '-package@example.test', password }) }); assert.equal(response.status, 200); const session = await response.json();
    actors[role] = { session, headers: { ...f.headers, Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken } };
  }
  const draft = customFormPackageDraft(await createCustomFormPackage(f.template, f.orgId), { code: 'PACKAGE-SUPERVISOR', name: '合成督導草稿' });
  await f.request('GET', 'form-templates/' + f.template.id, undefined, 200, actors.supervisor.headers); await f.request('POST', 'form-templates', draft, 201, actors.supervisor.headers);
  let before = f.state();
  for (const role of ['finance', 'caregiver']) for (const [method, route, payload] of [['GET', 'form-templates/' + f.template.id, undefined], ['POST', 'form-templates', draft]]) await f.request(method, route, payload, 403, actors[role].headers);
  await f.request('GET', 'form-templates/' + f.template.id, undefined, 403, { ...actors.supervisor.headers, 'X-Org-Id': 'unknown-org' }); assert.deepEqual(f.state(), before);
  f.app.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.orgId, actors.supervisor.session.user.id); before = f.state();
  await f.request('GET', 'form-templates/' + f.template.id, undefined, 403, actors.supervisor.headers); await f.request('POST', 'form-templates', { ...draft, code: 'REVOKED' }, 403, actors.supervisor.headers); assert.deepEqual(f.state(), before);
});
