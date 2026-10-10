import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

const endpoint = '/api/supervisory-visits';
const questionKeys = Array.from({ length: 10 }, (_, index) => 'q' + String(index + 1).padStart(3, '0'));
const rowKeys = ['id', 'orgId', 'version', 'templateId', 'caseId', 'caseNo', 'caseName', 'date', 'status', 'answerContainerKind', 'hasUnknownAnswerKeys', 'answers'];
const password = 'synthetic-visit-password';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(base + path, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成訪視管理員', email: 'visit-admin@example.test', password, organizationName: '合成訪視機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, data, client = admin) {
    const response = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const response = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employee = await create('employees', { name: '合成訪視居服員', employeeNo: 'SV-EMP' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = 'visit-' + role + '@example.test';
    await create('users', { name: '合成訪視' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseItem = await create('cases', { name: '合成同名個案', caseNo: 'SV-CASE-A' });
  const payload = overrides => ({ caseId: caseItem.id, templateId: 'assessment-04', date: '2026-10-10', status: 'draft', answers: { q001: '2026-09-01', q007: '合成訪視內容' }, ...overrides });
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table'); assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(row => {
      const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true);
      return [row.name, statement.all()];
    })), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  async function read(client, path = endpoint, method = 'GET', data, headers = {}, rawBody) {
    const before = raw(), result = await request(client, method, path, data, headers, rawBody);
    assert.deepEqual(raw(), before, 'Read and rejected operation must preserve all11 tables, schema,6 triggers and total_changes: ' + method + ' ' + path);
    return result;
  }
  function imported(data, options = {}) {
    const recordId = options.id ?? id(), org = options.org ?? admin.org, entity = options.entity ?? 'assessments', version = options.version ?? 1;
    const created = options.created ?? now();
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, org, entity, options.rawData ?? JSON.stringify(data), version, created, created);
    return { ...data, id: recordId, orgId: org, version };
  }
  async function foreign() {
    const org = await create('organizations', { name: '合成訪視機構乙' }), client = { ...admin, org: org.id };
    const parent = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'SV-FOREIGN' }, client);
    const item = await create('assessments', payload({ caseId: parent.id, answers: { q007: 'SYNTHETIC-FOREIGN-VISIT' } }), client);
    return { client, parent, item };
  }
  return { app, base, admin, clients, employee, caseItem, payload, create, patch, request, read, raw, imported, foreign };
}

const keys = (actual, expected) => assert.deepEqual(Object.keys(actual).sort(), [...expected].sort());
const singlePath = item => endpoint + '/' + encodeURIComponent(item.id);
const assertError = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code); };

test('exact dedicated DTO preserves all ten raw strings and reads current case names without changing saved answers', async t => {
  const f = await fixture(t), answers = Object.fromEntries(questionKeys.map((key, index) => [key, index === 1 ? '' : index === 6 ? ' \r\n合成長文字<script>literal</script>\n' + '長'.repeat(12000) : ' 原文' + key + '\r\n ']));
  const saved = await f.create('assessments', f.payload({ answers, status: 'submitted' }));
  const list = await f.read(f.admin); assert.equal(list.status, 200); keys(list.body, ['items', 'total', 'page', 'pageSize', 'filters']);
  assert.deepEqual(list.body.filters, { q: '', status: '', date: '', caseId: '' }); assert.equal(list.body.total, 1); assert.equal(list.body.pageSize, 25);
  const row = list.body.items[0]; keys(row, rowKeys); keys(row.answers, questionKeys);
  assert.equal(row.answerContainerKind, 'object'); assert.equal(row.hasUnknownAnswerKeys, false);
  for (const key of questionKeys) assert.deepEqual(row.answers[key], { kind: 'string', value: answers[key] });
  assert.equal(row.caseName, f.caseItem.name); assert.equal(row.caseNo, f.caseItem.caseNo); assert.equal(row.version, 1);
  const parent = await f.patch('cases', f.caseItem, { name: '合成目前新名稱', caseNo: 'SV-CURRENT', status: 'closed' });
  const single = await f.read(f.clients.supervisor, singlePath(saved)); keys(single.body, ['item']);
  assert.equal(single.body.item.caseName, parent.name); assert.equal(single.body.item.caseNo, parent.caseNo);
  assert.deepEqual(single.body.item.answers, row.answers); assert.equal(single.body.item.version, saved.version);
  assert.equal((await f.read(f.admin, '/api/assessments/' + saved.id)).body.item.answers.q007, answers.q007);
});

test('primitive and container tags distinguish missing/null/empty/zero/false while unknown and nested contents stay hidden', async t => {
  const f = await fixture(t), secret = 'SYNTHETIC-HIDDEN-NESTED';
  const answers = { q001: '', q002: null, q003: [], q004: { private: secret }, q005: 0, q006: false, q007: '0', q008: 'false', q009: 2.5, unknownSecret: secret, '__proto__': { private: secret } };
  const item = f.imported(f.payload({ answers })), row = (await f.read(f.admin, singlePath(item))).body.item;
  assert.deepEqual(row.answers, { q001: { kind: 'string', value: '' }, q002: { kind: 'null' }, q003: { kind: 'array' }, q004: { kind: 'object' }, q005: { kind: 'number' }, q006: { kind: 'boolean' }, q007: { kind: 'string', value: '0' }, q008: { kind: 'string', value: 'false' }, q009: { kind: 'number' }, q010: { kind: 'missing' } });
  assert.equal(row.hasUnknownAnswerKeys, true); assert(!JSON.stringify(row).includes(secret)); assert(!JSON.stringify(row).includes('unknownSecret'));
  const containers = [{ kind: 'missing', omit: true }, { kind: 'null', value: null }, { kind: 'array', value: [secret] }, { kind: 'string', value: secret }, { kind: 'number', value: 0 }, { kind: 'boolean', value: false }, { kind: 'object', value: {} }];
  for (const entry of containers) {
    const data = f.payload({ answers: entry.value }); if (entry.omit) delete data.answers;
    const imported = f.imported(data), result = await f.read(f.admin, singlePath(imported)); assert.equal(result.status, 200);
    assert.equal(result.body.item.answerContainerKind, entry.kind); assert.equal(result.body.item.hasUnknownAnswerKeys, false);
    assert(questionKeys.every(key => result.body.item.answers[key].kind === 'missing')); assert(!JSON.stringify(result.body).includes(secret));
  }
  const wrongCase = f.imported({ name: { secret }, caseNo: [secret], status: 'paused' }, { entity: 'cases' });
  const odd = f.imported(f.payload({ caseId: wrongCase.id })); const projected = (await f.read(f.admin, singlePath(odd))).body.item;
  assert.equal(projected.caseName, ''); assert.equal(projected.caseNo, ''); assert(!JSON.stringify(projected).includes(secret));
});

test('q matches only individual own saved strings with exact original echo and cannot search metadata or hidden values', async t => {
  const f = await fixture(t), answers = { q001: 'VisitDateMarker', q002: ' 原文保留 ', q003: 'FIRST', q004: 'SECOND', q005: 77, q006: false, q007: { nested: 'NESTED-MARKER' }, q008: ['ARRAY-MARKER'], unknown: 'UNKNOWN-MARKER' };
  f.imported(f.payload({ answers }));
  for (const q of ['visitdatemarker', 'first', ' 原文保留 ']) {
    const result = await f.read(f.admin, endpoint + '?q=' + encodeURIComponent(q)); assert.equal(result.body.total, 1); assert.equal(result.body.filters.q, q);
  }
  for (const q of ['FIRSTSECOND', 'NESTED-MARKER', 'ARRAY-MARKER', 'UNKNOWN-MARKER', '77', 'false', 'number', 'draft', 'assessment-04', f.caseItem.name, f.caseItem.caseNo, f.caseItem.id, f.admin.org]) {
    assert.equal((await f.read(f.clients.supervisor, endpoint + '?q=' + encodeURIComponent(q))).body.total, 0, q);
  }
  const boundary = '字'.repeat(200); assert.equal((await f.read(f.admin, endpoint + '?q=' + boundary)).status, 200);
  assertError(await f.read(f.admin, endpoint + '?q=' + '😀'.repeat(101)), 422, 'INVALID_QUERY');
});

test('exact metadata date/status and explicit current case filters separate duplicate names and preserve paused/closed case access', async t => {
  const f = await fixture(t), second = await f.create('cases', { name: f.caseItem.name, caseNo: 'SV-CASE-B', status: 'paused' });
  const one = f.imported(f.payload()), two = f.imported(f.payload({ caseId: second.id, date: '2026-10-11', status: 'submitted', answers: { q001: '2026-10-10', q009: '2026-10-10' } }));
  f.imported(f.payload({ templateId: 'assessment-03' }));
  const first = await f.read(f.admin, endpoint + '?caseId=' + f.caseItem.id); assert.deepEqual(first.body.items.map(x => x.id), [one.id]);
  const filtered = await f.read(f.clients.supervisor, endpoint + '?status=submitted&date=2026-10-11&caseId=' + second.id); assert.deepEqual(filtered.body.items.map(x => x.id), [two.id]);
  assert.deepEqual(filtered.body.filters, { q: '', status: 'submitted', date: '2026-10-11', caseId: second.id });
  assert.equal((await f.read(f.admin, endpoint + '?date=2026-10-10')).body.total, 1, 'Outer fill date must not match saved visit or form dates');
  await f.patch('cases', second, { status: 'closed' }); assert.equal((await f.read(f.admin, singlePath(two))).status, 200);
  const foreign = await f.foreign();
  for (const caseId of [foreign.parent.id, f.employee.id, id(), ' ' + f.caseItem.id + ' ']) assertError(await f.read(f.admin, endpoint + '?caseId=' + encodeURIComponent(caseId)), 404, 'NOT_FOUND');
  for (const caseId of [' ', '\r\n', '字'.repeat(501)]) assertError(await f.read(f.admin, endpoint + '?caseId=' + encodeURIComponent(caseId)), 422, 'INVALID_QUERY');
  assertError(await f.read(f.admin, endpoint + '?caseId=' + '字'.repeat(500)), 404, 'NOT_FOUND');
  assert.equal((await f.read(f.admin, endpoint + '?caseId=&date=&status=&q=')).body.total, 2);
});

test('25-plus3 paging uses original created_at-desc/id stable order and total counts with no hidden row insertion', async t => {
  const f = await fixture(t), expected = [], time = '2026-10-10T03:00:00.000Z';
  for (let n = 28; n >= 1; n--) expected.push(f.imported(f.payload({ answers: { q007: '共同訪視' + n } }), { id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), created: time }).id);
  expected.sort();
  const older = f.imported(f.payload(), { created: '2026-10-09T23:00:00.000Z' });
  const newer = f.imported(f.payload(), { created: '2026-10-10T04:00:00.000Z' });
  const first = await f.read(f.admin, endpoint + '?q=共同訪視'), second = await f.read(f.clients.supervisor, endpoint + '?q=共同訪視&page=2');
  assert.equal(first.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
  assert.deepEqual([...first.body.items, ...second.body.items].map(x => x.id), expected);
  assert.equal(new Set([...first.body.items, ...second.body.items].map(x => x.id)).size, 28);
  const all = await f.read(f.admin, endpoint + '?pageSize=100'); assert.equal(all.body.items[0].id, newer.id); assert.equal(all.body.items.at(-1).id, older.id);
  const empty = await f.read(f.admin, endpoint + '?page=9007199254740991'); assert.equal(empty.body.total, 30); assert.deepEqual(empty.body.items, []);
});

test('closed six-key query rejects duplicates and nonlexical pagination; empty filters and calendar year0000 remain explicit', async t => {
  const f = await fixture(t); f.imported(f.payload({ date: '0000-01-01' }));
  const invalid = ['unknown=1', 'startDate=2026-10-10', 'employeeId=x', 'month=2026-10', 'compare=previous', 'status=active', 'status=%20draft', 'date=2026-02-29', 'date=2026-1-01', 'date=2026-10-10T00:00:00Z', 'date=%202026-10-10%20', 'q=' + '字'.repeat(201)];
  for (const key of ['page', 'pageSize', 'q', 'status', 'date', 'caseId']) invalid.push(key + '=1&' + key + '=1');
  for (const key of ['page', 'pageSize']) for (const value of ['', '0', '-1', '+1', '01', '1.0', '1.2', '1e1', 'NaN', 'Infinity', ' 1', '1 ', '9007199254740992']) invalid.push(key + '=' + encodeURIComponent(value));
  invalid.push('pageSize=101');
  for (const query of invalid) assert.equal((await f.read(f.admin, endpoint + '?' + query)).status, 422, query);
  const valid = await f.read(f.admin, endpoint + '?q=&status=&date=0000-01-01&caseId=&page=1&pageSize=100');
  assert.equal(valid.status, 200); assert.equal(valid.body.total, 1); assert.equal(valid.body.items[0].date, '0000-01-01');
});

test('fresh single GET rejects every query and hides missing/foreign/wrong-template/wrong-entity/unreadable-parent identities', async t => {
  const f = await fixture(t), current = await f.create('assessments', f.payload()), foreign = await f.foreign();
  const wrongTemplate = f.imported(f.payload({ templateId: 'assessment-01' }));
  const missingParent = f.imported(f.payload({ caseId: id() })), wrongParent = f.imported(f.payload({ caseId: f.employee.id })), foreignParent = f.imported(f.payload({ caseId: foreign.parent.id }));
  for (const client of [f.admin, f.clients.supervisor]) {
    for (const item of [foreign.item, wrongTemplate, missingParent, wrongParent, foreignParent, { id: f.employee.id }, { id: id() }]) assertError(await f.read(client, singlePath(item)), 404, 'NOT_FOUND');
    for (const query of ['q=', 'page=1', 'pageSize=25', 'status=draft', 'date=2026-10-10', 'caseId=', 'unknown=', 'q=x&q=x']) assertError(await f.read(client, singlePath(current) + '?' + query), 422, 'INVALID_QUERY');
    for (const path of [endpoint + '/', singlePath(current) + '/history', singlePath(current) + '/unknown', singlePath(current) + '/history?compare=previous']) assertError(await f.read(client, path), 404, 'NOT_FOUND');
  }
  const changed = await f.patch('assessments', current, { answers: { q007: '合成已更新的保存內容' }, status: 'submitted' }, f.clients.supervisor);
  const fresh = await f.read(f.admin, singlePath(current)); assert.equal(fresh.body.item.version, 2); assert.equal(fresh.body.item.answers.q007.value, changed.answers.q007);
  await f.patch('assessments', changed, { templateId: 'assessment-02' }); assertError(await f.read(f.admin, singlePath(current)), 404, 'NOT_FOUND');
});

test('four-role guards reject finance/caregiver before query/body parsing yet preserve original assessment and history authorization', async t => {
  const f = await fixture(t), current = await f.create('assessments', f.payload());
  for (const role of ['finance', 'caregiver']) for (const path of [endpoint, singlePath(current), endpoint + '/' + id(), singlePath(current) + '/history', endpoint + '/missing/unknown']) {
    assertError(await f.read(f.clients[role], path + '?unknown=1&page=0&date=bogus'), 403, 'ROLE_FORBIDDEN');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) assertError(await f.read(f.clients[role], path + '?unknown=1', method, undefined, { 'Content-Type': 'text/plain' }, method === 'OPTIONS' ? undefined : '{'), 403, 'ROLE_FORBIDDEN');
  }
  for (const client of [f.admin, f.clients.supervisor]) assert.equal((await f.read(client)).status, 200);
  assert.equal((await f.read(f.clients.finance, '/api/assessments/' + current.id)).status, 200);
  assert.equal((await f.read(f.clients.finance, '/api/assessments/' + current.id + '/history?compare=previous')).status, 200);
  assert.equal((await f.read(f.clients.caregiver, '/api/assessments/' + current.id)).status, 403);
  assertError(await f.read(null), 401, 'AUTH_REQUIRED');
  assertError(await f.read({ ...f.admin, org: '' }), 400, 'ORG_REQUIRED');
  assertError(await f.read({ ...f.admin, org: id() }), 403, 'ORG_FORBIDDEN');
});

test('known dedicated routes return405 before any body parsing without weakening mutating Origin/CSRF or handling unknown tails', async t => {
  const f = await fixture(t), current = f.imported(f.payload());
  for (const client of [f.admin, f.clients.supervisor]) for (const path of [endpoint, singlePath(current)]) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assertError(await f.read(client, path + '?unknown=1', method, undefined, { 'Content-Type': 'text/plain', 'Idempotency-Key': 'bad key' }, '{'), 405, 'METHOD_NOT_ALLOWED');
      assertError(await f.read(client, path, method, undefined, { 'Content-Type': 'application/json' }, '{"secret":"' + 'X'.repeat(140000) + '"}'), 405, 'METHOD_NOT_ALLOWED');
    }
    assertError(await f.read(client, path, 'OPTIONS'), 405, 'METHOD_NOT_ALLOWED'); assert.equal((await f.read(client, path, 'HEAD')).status, 405);
  }
  for (const headers of [{ 'X-CSRF-Token': '' }, { Origin: 'https://synthetic-wrong-origin.example.test' }]) {
    const response = await f.read(f.admin, endpoint, 'POST', { unknown: true }, headers); assert.equal(response.status, 403);
    assert(['CSRF_INVALID', 'ORIGIN_FORBIDDEN'].includes(response.body.error.code));
  }
  assertError(await f.read(f.admin, singlePath(current) + '/unknown', 'POST', undefined, { 'Content-Type': 'text/plain' }, '{'), 404, 'NOT_FOUND');
  const keyed = await f.read(f.admin, endpoint, 'GET', undefined, { 'Idempotency-Key': 'synthetic-read-key' }); assert.equal(keyed.status, 200);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM idempotency').get().n, 0);
});

test('invalid selected metadata returns409 across all matching candidates before pagination without repairing raw data', async t => {
  const f = await fixture(t);
  for (const patch of [{ date: '2026-02-29' }, { date: null }, { status: 'unknown' }, { status: null }]) {
    const item = f.imported(f.payload(patch)); assertError(await f.read(f.admin, singlePath(item)), 409, 'VISIT_DATA_INVALID');
  }
  assertError(await f.read(f.admin), 409, 'VISIT_DATA_INVALID');
  assert.equal((await f.read(f.admin, endpoint + '?date=2026-10-11')).status, 200, 'Explicit filters exclude outside query invalid dates/status');
  const otherCase = await f.create('cases', { name: '合成分頁個案', caseNo: 'SV-PAGE' });
  for (let n = 0; n < 26; n++) f.imported(f.payload({ caseId: otherCase.id, answers: { q007: '合成分頁' } }), { created: '2026-10-10T06:00:00.000Z' });
  const damaged = f.imported(f.payload({ caseId: otherCase.id, answers: { q007: '合成分頁' } }), { version: 0, created: '2026-10-09T00:00:00.000Z' });
  assertError(await f.read(f.admin, endpoint + '?caseId=' + otherCase.id + '&page=1'), 409, 'VISIT_DATA_INVALID');
  assertError(await f.read(f.admin, singlePath(damaged)), 409, 'VISIT_DATA_INVALID');
  for (const version of [-1, 1.5, 9007199254740993n]) {
    const item = f.imported(f.payload({ caseId: otherCase.id }), { version }); assertError(await f.read(f.admin, singlePath(item)), 409, 'VISIT_DATA_INVALID');
  }
  const blankId = f.imported(f.payload({ caseId: otherCase.id }), { id: '   ' });
  assertError(await f.read(f.admin, singlePath(blankId)), 409, 'VISIT_DATA_INVALID');
  assert.equal((await f.read(f.admin, endpoint + '?q=合成不存在匹配')).status, 200);
});

test('safe SQLite versions do not make unrelated templates or unreadable parents poison a valid selected result', async t => {
  const f = await fixture(t), foreign = await f.foreign(), unsafe = 9007199254740993n;
  const good = f.imported(f.payload());
  f.imported(f.payload({ templateId: 'assessment-01' }), { version: unsafe });
  f.imported(f.payload({ caseId: id() }), { version: unsafe });
  f.imported(f.payload({ caseId: foreign.parent.id }), { version: unsafe });
  f.imported(f.payload({ caseId: foreign.parent.id }), { version: unsafe, org: foreign.client.org });
  const response = await f.read(f.admin); assert.equal(response.status, 200); assert.deepEqual(response.body.items.map(x => x.id), [good.id]);
  assert.equal((await f.read(f.admin, singlePath(good))).status, 200);
  const outsideDate = f.imported(f.payload({ date: '2026-10-11' }), { version: unsafe });
  assert.equal((await f.read(f.admin, endpoint + '?date=2026-10-10')).status, 200);
  assertError(await f.read(f.admin, singlePath(outsideDate)), 409, 'VISIT_DATA_INVALID');
});

test('unsupported nonfinite direct values fail409 while hidden nested and unknown values do not become contents or search keys', async t => {
  const f = await fixture(t);
  for (const rawAnswers of ['1e400', '{"q007":1e400}']) {
    const data = f.payload({ answers: null }), rawData = JSON.stringify(data).replace('"answers":null', '"answers":' + rawAnswers);
    const item = f.imported(data, { rawData }); assertError(await f.read(f.admin, singlePath(item)), 409, 'VISIT_DATA_INVALID');
  }
  const data = f.payload({ answers: null }), rawData = JSON.stringify(data).replace('"answers":null', '"answers":{"q001":{"private":1e400},"unknown":1e400,"q007":"finite known"}');
  const item = f.imported(data, { rawData }), result = await f.read(f.admin, singlePath(item)); assert.equal(result.status, 200);
  assert.deepEqual(result.body.item.answers.q001, { kind: 'object' }); assert.equal(result.body.item.hasUnknownAnswerKeys, true);
  assert.equal((await f.read(f.admin, endpoint + '?q=finite%20known')).body.total, 1);
  assert.equal((await f.read(f.admin, endpoint + '?q=Infinity')).body.total, 0);
});

test('original assessments writes and exactprevious actors/history remain untouched across template/case changes and orphan current scope', async t => {
  const f = await fixture(t), second = await f.create('cases', { name: '合成另一個案', caseNo: 'SV-HISTORY' });
  let item = await f.create('assessments', f.payload());
  item = await f.patch('assessments', item, { templateId: 'assessment-02', caseId: second.id, answers: { q007: '合成原第二版' } }, f.clients.supervisor);
  item = await f.patch('assessments', item, { templateId: 'assessment-04', caseId: f.caseItem.id, answers: { q007: '合成原第三版' } });
  const historyPath = '/api/assessments/' + item.id + '/history?compare=previous';
  const history = await f.read(f.clients.supervisor, historyPath); assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.map(x => x.snapshot.templateId), ['assessment-04', 'assessment-02', 'assessment-04']);
  assert.equal(history.body.items[0].comparison.previousVersion, 2); assert.equal(history.body.items[0].comparison.previousSnapshot.caseId, second.id);
  assert.equal(history.body.items[1].actor.id, f.clients.supervisor.user.id); assert.equal(history.body.items[0].actor.id, f.admin.user.id);
  assert.equal((await f.read(f.clients.finance, historyPath)).status, 200);
  const row = await f.read(f.admin, singlePath(item)); assert.equal(row.body.item.answers.q007.value, '合成原第三版');
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ caseId: id(), templateId: 'assessment-04', date: item.date, status: item.status, answers: item.answers }), item.id);
  assertError(await f.read(f.admin, singlePath(item)), 404, 'NOT_FOUND');
  assert.equal((await f.read(f.admin, historyPath)).body.items.length, 3);
  assert.equal((await f.read(f.admin, '/api/assessments/' + item.id)).status, 200, 'Original current scope is not changed to dedicated parent join');
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('synthetic-tamper', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
});

test('dedicated reads/filters/failures preserve approved billing snapshot and both BLOB tables with all immutable schema and no idempotency inserts', async t => {
  const f = await fixture(t), visit = await f.create('assessments', f.payload());
  const service = await f.create('service-items', { code: 'SV-SVC', name: '合成保護服務', minutes: 60, unitPriceCents: 8765 });
  const plan = await f.create('care-plans', { caseId: f.caseItem.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 5 }] });
  const shift = await f.create('shifts', { caseId: f.caseItem.id, employeeId: f.employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: plan.services });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: f.caseItem.id, employeeId: f.employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:55', services: shift.services, status: 'submitted' });
  assert.equal((await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成原核閱' })).status, 200);
  const pdf = Buffer.from('%PDF-1.4\nSynthetic visit protected attachment\n%%EOF');
  await f.create('case-attachments/upload', { caseId: f.caseItem.id, title: '合成個案附件', fileName: 'synthetic-case.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' });
  await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成證照附件', fileName: 'synthetic-cert.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const before = f.raw(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  assert.deepEqual(Buffer.from(before.tables.attachment_files[0].content), pdf); assert.deepEqual(Buffer.from(before.tables.certification_attachment_files[0].content), pdf);
  const approved = (await f.read(f.admin, '/api/service-records/' + record.id)).body.item.billingSnapshot; assert(approved);
  for (const path of [endpoint, singlePath(visit), endpoint + '?date=2026-10-10&status=draft', endpoint + '?q=合成不存在', endpoint + '?caseId=' + id(), singlePath(visit) + '?q=']) await f.read(f.admin, path, 'GET', undefined, { 'Idempotency-Key': 'synthetic-same-read-key' });
  await f.read(f.clients.finance, endpoint); await f.read(f.admin, singlePath(visit), 'POST', { answers: { q007: '合成不允許的寫入' } }, { 'Idempotency-Key': 'synthetic-rejected-write-key' });
  assert.deepEqual(f.raw(), before); assert.equal(f.app.db.prepare('SELECT count(*) n FROM idempotency').get().n, 0);
  assert.deepEqual((await f.read(f.admin, '/api/service-records/' + record.id)).body.item.billingSnapshot, approved);
});
