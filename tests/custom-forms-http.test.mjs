import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert } from '../src/server/model.mjs';

const question = (key, type, extra = {}) => ({ key, label: '合成' + key, type, groupId: '', required: false, options: [], visibleIf: null, ...extra });
const schema = () => [question('concern', 'boolean'), question('detail', 'textarea', { required: true, visibleIf: { field: 'concern', equals: true } }), question('reading', 'number'), question('day', 'date'), question('choice', 'select', { options: [{ value: 'one', label: '合成一' }, { value: 'two', label: '合成二' }] }), question('actions', 'multiselect', { options: [{ value: 'a', label: '合成甲' }, { value: 'b', label: '合成乙' }] }), question('summary', 'text')];
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '合成表單管理員', organizationName: '合成表單機構', email: 'forms-http@example.test', password: 'synthetic-forms-http-password' }) });
  assert.equal(setup.status, 201); const session = await setup.json(), orgId = session.organizations[0].id;
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken };
  const request = async (method, route, data, expected = 200, custom = headers) => { const r = await fetch(base + '/api/' + route, { method, headers: custom, ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) }); assert.equal(r.status, expected, await r.clone().text()); return r.json(); };
  const create = async (entity, data, custom = headers) => (await request('POST', entity, data, 201, custom)).item;
  const patch = async (entity, item, data, expected = 200) => request('PATCH', entity + '/' + item.id, { version: item.version, ...data }, expected);
  const c = await create('cases', { name: '合成個案甲', caseNo: 'FORM-A' });
  let template = await create('form-templates', { code: 'FORM-HTTP', name: '合成七型表單', revision: 1, fields: schema() });
  template = (await patch('form-templates', template, { status: 'published' })).item;
  const data = extra => ({ caseId: c.id, templateId: template.id, templateVersion: template.version, date: '2026-10-10', ...extra });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, records: (() => { const q = app.db.prepare('SELECT * FROM records ORDER BY id'); q.setReadBigInts(true); return q.all(); })(), versions: (() => { const q = app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version'); q.setReadBigInts(true); return q.all(); })(), audit: app.db.prepare('SELECT * FROM audit ORDER BY id').all() });
  return { app, base, session, orgId, headers, request, create, patch, c, template, data, state };
}
test('HTTP custom forms save ordinary seven-type drafts, enforce submitted locks and preserve inactive template snapshots', async t => {
  const f = await fixture(t); assert.equal(f.template.revision, 1); assert.equal(f.template.version, 2);
  const answers = { concern: true, detail: '  合成內容\r\n尾端  ', reading: '0.10', day: '0001-01-01', choice: 'one', actions: ['b', 'a'], summary: '合成摘要' };
  let item = await f.create('form-records', f.data({ answers, note: '  合成備註\r\n尾端  ' }));
  assert.deepEqual(item.answers, answers); assert.equal(item.templateSnapshot.version, 2); assert.equal(item.templateSnapshot.revision, 1);
  const first = structuredClone(item); item = (await f.patch('form-records', item, { status: 'submitted' })).item;
  await f.patch('form-templates', f.template, { status: 'inactive' });
  const baseline = f.state(); assert.deepEqual((await f.request('GET', 'form-records/' + item.id)).item, item);
  const history = await f.request('GET', 'form-records/' + item.id + '/history?compare=previous');
  assert.equal(history.total, 2); assert.deepEqual(history.items.map(row => row.version), [2, 1]);
  assert.deepEqual(history.items[0].snapshot.answers, answers); assert.deepEqual(history.items[0].comparison.previousSnapshot.templateSnapshot, first.templateSnapshot);
  assert.equal(history.items[0].actor.id, f.session.user.id); assert.deepEqual(f.state(), baseline);
  await f.patch('form-records', item, { note: '拒改' }, 409); await f.request('POST', 'form-records', f.data(), 409); assert.deepEqual(f.state(), baseline);
  const next = await f.create('form-templates', { code: f.template.code, name: '合成新版', revision: 2, previousTemplateId: f.template.id, fields: schema() }); assert.notEqual(next.id, f.template.id); assert.equal(next.version, 1);
});
test('HTTP exact roles, closed bodies, parent scope, CAS and idempotency reject without partial writes', async t => {
  const f = await fixture(t), employee = await f.create('employees', { name: '合成居服', employeeNo: 'FORM-E' });
  const actors = {};
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    await f.create('users', { name: '合成' + role, email: role + '-form@example.test', password: 'synthetic-forms-role-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const r = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: role + '-form@example.test', password: 'synthetic-forms-role-password' }) }); assert.equal(r.status, 200); const auth = await r.json(); actors[role] = { ...f.headers, Cookie: r.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': auth.csrfToken };
  }
  const other = await f.create('organizations', { name: '合成其他機構' }); const foreign = await f.create('cases', { name: '合成他機構個案', caseNo: 'FORM-FOREIGN' }, { ...f.headers, 'X-Org-Id': other.id });
  let item = await f.create('form-records', f.data({ answers: { concern: false } }));
  let baseline = f.state();
  for (const role of ['finance', 'caregiver']) for (const entity of ['form-templates', 'form-records']) {
    await f.request('GET', entity + '?secret=unknown', undefined, 403, actors[role]); await f.request('POST', entity, '{invalid', 403, actors[role]);
    await f.request('GET', entity + '/' + (entity === 'form-templates' ? f.template.id : item.id) + '/history', undefined, 403, actors[role]);
  }
  await f.request('GET', 'form-records/' + item.id, undefined, 200, actors.supervisor);
  for (const extra of [{ caseId: foreign.id }, { templateVersion: 1 }, { templateVersion: {} }, { templateSnapshot: item.templateSnapshot }, { answers: { concern: false, detail: '拒收隱藏' } }, { answers: { reading: 0.1 } }, { answers: { day: '0000-01-01' } }]) await f.request('POST', 'form-records', f.data(extra), extra.caseId ? 404 : extra.templateVersion === 1 ? 409 : 422);
  await f.patch('form-records', item, { answers: { concern: true }, status: 'submitted' }, 422);
  await f.patch('form-records', item, { caseId: foreign.id }, 409);
  await f.patch('form-records', item, { version: 99, note: '拒CAS' }, 409);
  await f.patch('form-templates', f.template, { fields: schema().slice(0, 1) }, 409);
  for (const query of ['page=1%0A', 'date=2026-10-10%0A', 'pageSize=9007199254740993', 'q=a&q=b', 'unknown=x']) await f.request('GET', 'form-records?' + query, undefined, 422);
  assert.deepEqual(f.state(), baseline);
  const keyHeaders = { ...f.headers, 'Idempotency-Key': randomUUID() }, payload = f.data({ note: '合成相同重試' });
  const a = await f.create('form-records', payload, keyHeaders); baseline = f.state(); const b = await f.create('form-records', payload, keyHeaders); assert.deepEqual(a, b); assert.deepEqual(f.state(), baseline);
  await f.request('POST', 'form-records', { ...payload, note: '不同內容' }, 409, keyHeaders); assert.deepEqual(f.state(), baseline);
  const own = insert(f.app.db, f.orgId, 'case-attachments', { caseId: f.c.id, title: '合成引用', status: 'active' });
  const wrong = insert(f.app.db, f.orgId, 'case-attachments', { caseId: foreign.id, title: '合成錯誤父層', status: 'active' }); baseline = f.state();
  await f.request('POST', 'form-records', f.data({ attachmentIds: [wrong.id] }), 422); assert.deepEqual(f.state(), baseline);
  item = (await f.patch('form-records', item, { attachmentIds: [own.id] })).item; assert.deepEqual(item.attachmentIds, [own.id]); assert.equal(f.app.db.prepare('SELECT count(*) n FROM attachment_files').get().n, 0);
});
test('HTTP unsafe history SQL versions and malformed current/snapshot JSON remain hidden and read-only', async t => {
  const f = await fixture(t), item = await f.create('form-records', f.data({ answers: { concern: false } }));
  const ins = f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)');
  for (const [version, snapshot] of [[9007199254740993n, JSON.stringify(item)], [9007199254740992n, 'null'], [10, '{invalid'], [11, JSON.stringify({ ...item, version: 12 })], [12, JSON.stringify({ ...item, version: 12, answers: { unknown: 'hidden-synthetic-value' } })], [13, JSON.stringify({ ...item, version: 13, templateSnapshot: { ...item.templateSnapshot, extra: 'hidden-synthetic-value' } })], [0, JSON.stringify({ ...item, version: 0 })]]) ins.run(f.orgId, 'form-records', item.id, version, snapshot, item.updatedAt, 'synthetic-corruption-fixture');
  let baseline = f.state(); const history = await f.request('GET', 'form-records/' + item.id + '/history?compare=previous'); assert.equal(history.total, 1); assert.equal(history.items[0].version, 1); assert.ok(!JSON.stringify(history).includes('hidden-synthetic-value')); assert.deepEqual(f.state(), baseline);
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run('{invalid', item.id); baseline = f.state();
  await f.request('GET', 'form-records/' + item.id, undefined, 404); await f.request('GET', 'form-records/' + item.id + '/history', undefined, 404);
  assert.equal((await f.request('GET', 'form-records')).total, 0); await f.patch('form-records', item, { note: '拒寫損壞資料' }, 404); assert.deepEqual(f.state(), baseline);
});
test('HTTP full fifty-question long-text payload uses bounded custom body/answer limits', async t => {
  const f = await fixture(t), fields = Array.from({ length: 50 }, (_, i) => question('long' + i, 'textarea', { required: true })), answers = Object.fromEntries(fields.map(q => [q.key, '合'.repeat(10000)]));
  let template = await f.create('form-templates', { code: 'FORM-LARGE', name: '合成完整長文', revision: 1, fields }); template = (await f.patch('form-templates', template, { status: 'published' })).item;
  let item = await f.create('form-records', { caseId: f.c.id, templateId: template.id, templateVersion: template.version, date: '9999-12-31', answers });
  assert.deepEqual(item.answers, answers); item = (await f.patch('form-records', item, { status: 'submitted' })).item; assert.equal(item.status, 'submitted');
  const baseline = f.state(); const read = await f.request('GET', 'form-records/' + item.id); assert.equal(read.item.answers.long49.length, 10000); assert.equal((await f.request('GET', 'form-records?date=9999-12-31')).total, 1); assert.deepEqual(f.state(), baseline);
});
test('HTTP corrupt template occupancy blocks revision allocation without repairing or ignoring storage', async t => {
  const f = await fixture(t), draft = await f.create('form-templates', { code: 'FORM-HELD', name: '合成佔用草稿', revision: 1, fields: schema() });
  const sql = f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?');
  const original = f.app.db.prepare('SELECT data,version FROM records WHERE id=?').get(draft.id);
  for (const [data, version] of [['{invalid', 1], ['null', 1], [original.data, 9007199254740993n], [JSON.stringify({ ...JSON.parse(original.data), fields: [{ ...schema()[0], extra: 'synthetic-closed-invalid' }] }), 1]]) {
    sql.run(data, version, draft.id); const baseline = f.state();
    await f.request('POST', 'form-templates', { code: 'FORM-HELD', name: '不可忽略佔用', revision: 1, fields: schema() }, 409);
    await f.patch('form-templates', f.template, { status: 'inactive' }, 409); assert.deepEqual(f.state(), baseline);
    sql.run(original.data, original.version, draft.id);
  }
  for (const suffix of ['\n', '\r']) { const fields = schema(); fields[0].key += suffix; const baseline = f.state(); await f.request('POST', 'form-templates', { code: 'FORM-LF', name: '拒尾行', revision: 1, fields }, 422); assert.deepEqual(f.state(), baseline); }
});
