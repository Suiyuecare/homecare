import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert } from '../src/server/model.mjs';
const E = 'employee-training-credits';
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); assert.notEqual(new URL(base).port, '4310'); t.after(() => app.close());
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '合成人工積分管理員', organizationName: '合成人工積分機構', email: 'credits-http@example.test', password: 'synthetic-credits-http-password' }) }); assert.equal(setup.status, 201); const auth = await setup.json(), orgId = auth.organizations[0].id;
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-Org-Id': orgId, 'X-CSRF-Token': auth.csrfToken };
  const request = async (method, route, data, expected = 200, custom = headers) => { const r = await fetch(base + '/api/' + route, { method, headers: custom, ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) }); assert.equal(r.status, expected, await r.clone().text()); return r.json(); };
  const create = async (entity, data, custom = headers) => (await request('POST', entity, data, 201, custom)).item;
  const patch = async (item, data, expected = 200, custom = headers) => request('PATCH', E + '/' + item.id, { version: item.version, ...data }, expected, custom);
  const employee = await create('employees', { name: '合成人員甲', employeeNo: 'CREDIT-A' }), second = await create('employees', { name: '合成人員乙', employeeNo: 'CREDIT-B' });
  const data = extra => ({ employeeId: employee.id, date: '2026-10-10', activityName: '合成人工積分活動', provider: '合成提供單位', creditValue: '001.230000', creditUnit: '來源甲單位', sourceReference: '  合成原始依據\r\n尾端  ', ...extra });
  const state = () => { const read = sql => { const q = app.db.prepare(sql); q.setReadBigInts(true); return q.all(); }; return { changes: app.db.prepare('SELECT total_changes() n').get().n, records: read('SELECT * FROM records ORDER BY id'), history: read('SELECT * FROM record_versions ORDER BY record_id,version'), audit: read('SELECT * FROM audit ORDER BY id'), idem: read('SELECT * FROM idempotency ORDER BY rowid') }; };
  return { app, base, auth, orgId, headers, request, create, patch, employee, second, data, state };
}
test('HTTP exact decimal/source persist, current metadata transitions lock and annual reads/history remain pure', async t => {
  const f = await fixture(t); let item = await f.create(E, f.data({ note: '  合成備註\r\n尾端  ' })); assert.equal(item.creditValue, '001.230000'); const first = structuredClone(item); let baseline = f.state();
  await f.patch(item, { status: 'verified' }, 422); await f.patch(item, { status: 'verified', verifiedOn: '2026-10-10', verificationBasis: ' ' }, 422); await f.patch(item, { status: 'voided', voidedOn: '2026-10-10', voidReason: '新原因' }, 422); assert.deepEqual(f.state(), baseline);
  item = (await f.patch(item, { status: 'verified', verifiedOn: '2026-10-10', verificationBasis: '  合成本次核對依據\r\n尾端  ' })).item; const verified = structuredClone(item); baseline = f.state();
  for (const data of [{ note: '改' }, { creditValue: '1.23' }, { employeeId: f.second.id }, { status: 'draft' }, { status: 'voided', voidReason: '新原因' }, { status: 'voided', voidedOn: '2026-10-11', voidReason: '新原因', sourceReference: '改' }]) await f.patch(item, data, data.status === 'draft' || data.status === 'voided' && !data.voidedOn ? 422 : 409);
  assert.deepEqual(f.state(), baseline); item = (await f.patch(item, { status: 'voided', voidedOn: '2026-10-11', voidReason: '  合成作廢新原因\r\n尾端  ' })).item; baseline = f.state();
  await f.patch(item, { note: '改终態' }, 409); await f.patch(item, { status: 'voided', voidedOn: '2026-10-12', voidReason: '另原因' }, 409); assert.deepEqual(f.state(), baseline);
  const history = await f.request('GET', E + '/' + item.id + '/history?compare=previous'); assert.equal(history.total, 3); assert.deepEqual(history.items.map(row => row.version), [3, 2, 1]); assert.deepEqual(history.items[0].comparison.previousSnapshot, verified); assert.deepEqual(history.items[2].snapshot, first); assert.equal(history.items[0].actor.id, f.auth.user.id);
  assert.deepEqual((await f.request('GET', E + '/' + item.id)).item, item); assert.equal((await f.request('GET', E + '?year=2026&employeeId=' + f.employee.id)).total, 1); assert.equal((await f.request('GET', E + '?year=0001')).total, 0); assert.equal((await f.request('GET', E + '?year=9999')).total, 0); assert.deepEqual(f.state(), baseline);
});
test('HTTP server roles and same-parent scope reject before unsafe bodies; caregiver reads only own current/history', async t => {
  const f = await fixture(t), item = await f.create(E, f.data()), secondItem = await f.create(E, f.data({ employeeId: f.second.id })), actors = {};
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    await f.create('users', { name: '合成' + role, email: role + '-credits@example.test', password: 'synthetic-credits-role-password', role, ...(role === 'caregiver' ? { employeeId: f.employee.id } : {}) });
    const r = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: role + '-credits@example.test', password: 'synthetic-credits-role-password' }) }); assert.equal(r.status, 200); const session = await r.json(); actors[role] = { ...f.headers, Cookie: r.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken };
  }
  const otherOrg = randomUUID(); f.app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(otherOrg, '合成另一機構', '2026-10-10T00:00:00Z'); const outside = insert(f.app.db, otherOrg, 'employees', { name: '合成外機構員工', status: 'active' }); const baseline = f.state();
  for (const role of ['finance', 'caregiver']) { await f.request('POST', E, '{invalid', 403, actors[role]); await f.request('PATCH', E + '/' + item.id, '{invalid', 403, actors[role]); }
  await f.request('GET', E + '?unknown=1', undefined, 403, actors.finance); await f.request('GET', E + '/' + item.id + '/history', undefined, 403, actors.finance);
  assert.equal((await f.request('GET', E, undefined, 200, actors.caregiver)).total, 1); assert.deepEqual((await f.request('GET', E + '/' + item.id, undefined, 200, actors.caregiver)).item, item); assert.equal((await f.request('GET', E + '/' + item.id + '/history', undefined, 200, actors.caregiver)).total, 1);
  await f.request('GET', E + '/' + secondItem.id, undefined, 404, actors.caregiver); await f.request('GET', E + '/' + secondItem.id + '/history', undefined, 404, actors.caregiver); await f.request('GET', E + '?employeeId=' + f.second.id, undefined, 404, actors.caregiver);
  await f.request('POST', E, f.data({ employeeId: outside.id }), 404); await f.patch(item, { employeeId: f.second.id }, 409); assert.deepEqual(f.state(), baseline);
  const created = await f.create(E, f.data({ activityName: '合成督導紀錄' }), actors.supervisor); assert.equal(created.version, 1);
});
test('HTTP closed scalar bodies, strict queries, CAS, idempotency and numeric limits produce no partial writes', async t => {
  const f = await fixture(t), keyHeaders = { ...f.headers, 'Idempotency-Key': randomUUID() }, payload = f.data(); const one = await f.create(E, payload, keyHeaders), stateAfter = f.state(); const two = await f.request('POST', E, payload, 201, keyHeaders); assert.deepEqual(two.item, one); assert.deepEqual(f.state(), stateAfter);
  await f.request('POST', E, f.data({ creditValue: '1.23' }), 409, keyHeaders); assert.deepEqual(f.state(), stateAfter);
  let item = (await f.patch(one, { note: '合成修改' })).item; const baseline = f.state(); await f.patch(one, { note: '合成過時' }, 409);
  for (const data of [{ creditValue: 1 }, { creditValue: '1e2' }, { creditValue: '1\n' }, { creditValue: '1.1234567' }, { date: '2026-10-10\n' }, { creditUnit: '甲\n' }, { total: '1' }, { version: 1, employeeId: null }]) await f.request('POST', E, f.data(data), 422);
  for (const query of ['year=2026%0A', 'year=0000', 'year=2026&year=2026', 'page=1%0A', 'pageSize=101', 'status=draft%0A', 'employeeId=' + f.employee.id + '%0A', 'unknown=1']) await f.request('GET', E + '?' + query, undefined, 422);
  for (const query of ['page=1', 'year=2026', 'q=']) await f.request('GET', E + '/' + item.id + '?' + query, undefined, 422);
  for (const query of ['year=2026', 'compare=previous%0A', 'compare=next']) await f.request('GET', E + '/' + item.id + '/history?' + query, undefined, 422); assert.deepEqual(f.state(), baseline);
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER), item.id); item = (await f.request('GET', E + '/' + item.id)).item; const maxState = f.state(); await f.patch(item, { note: '不可溢位' }, 409); assert.deepEqual(f.state(), maxState);
});
test('HTTP malformed/null/unsafe current and history snapshots remain hidden, valid histories stay typed and reads never repair', async t => {
  const f = await fixture(t); let item = await f.create(E, f.data()); const original = structuredClone(item); item = (await f.patch(item, { note: '合成版二' })).item;
  const addHistory = (version, snapshot) => f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.orgId, E, item.id, version, snapshot, '2026-10-10T00:00:00Z', 'synthetic');
  addHistory(3, 'null'); addHistory(4, '{bad'); addHistory(5, JSON.stringify({ ...item, version: 5, unknown: '禁止' })); addHistory(6, JSON.stringify({ ...item, version: 7 })); addHistory(7, JSON.stringify({ ...item, version: 7, employeeId: f.second.id })); addHistory(9007199254740993n, JSON.stringify(item)); addHistory(0, JSON.stringify(original));
  const invalids = [];
  for (const [data, version] of [['null', 1], ['{bad', 1], [JSON.stringify({ ...f.data(), ...{ reference: '', note: '', status: 'draft', verifiedOn: '', verificationBasis: '', voidedOn: '', voidReason: '' }, unknown: '禁止' }), 1], [JSON.stringify({ ...f.data(), reference: '', note: '', status: 'draft', verifiedOn: '', verificationBasis: '', voidedOn: '', voidReason: '' }), 9007199254740993n]]) { const id = randomUUID(); f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, f.orgId, E, data, version, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z'); invalids.push(id); }
  const baseline = f.state(), history = await f.request('GET', E + '/' + item.id + '/history?compare=previous'); assert.deepEqual(history.items.map(row => row.version), [2, 1]); assert.deepEqual(history.items[0].comparison.previousSnapshot, original); assert.equal((await f.request('GET', E)).total, 1);
  for (const id of invalids) { await f.request('GET', E + '/' + id, undefined, 404); await f.request('GET', E + '/' + id + '/history', undefined, 404); }
  assert.deepEqual(f.state(), baseline);
});
