import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createAnnouncementReadFixture } from './announcement-read-receipts-fixtures.mjs';
import { readSyntheticRawState } from './synthetic-backup-fixtures.mjs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup, restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';

const ROLES = ['admin', 'supervisor', 'finance', 'caregiver'];
const RECEIPT_KEYS = ['id', 'orgId', 'announcementId', 'announcementVersion', 'userId', 'userName', 'role', 'readAt'];
const SNAPSHOT_KEYS = [...RECEIPT_KEYS, 'version', 'createdAt', 'updatedAt'];
const ANNOUNCEMENT_KEYS = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'title', 'body', 'audience', 'status'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
const receiptId = (org, announcement, version, user) => sha(Buffer.from(JSON.stringify(['suiyue-announcement-read-v1', org, announcement, version, user]), 'utf8'));
const route = item => '/api/announcements/' + item.id;
const stateRoute = (item, query = '') => route(item) + '/read-state' + (query ? '?' + query : '');
const rosterRoute = (item, query = '') => route(item) + '/read-receipts' + (query ? '?' + query : '');
const canonicalTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const rawDigest = raw => sha(Buffer.from(JSON.stringify({ typedSchema: raw.typedSchema, typedTables: raw.typedTables, userVersion: raw.userVersion, applicationId: raw.applicationId }), 'utf8'));
const savedState = f => ({ digest: rawDigest(f.rawState()), counts: f.counts() });
const unchanged = (f, before, label) => same(savedState(f), before, label);
const projectedAnnouncement = item => Object.fromEntries(ANNOUNCEMENT_KEYS.map(key => [key, item[key]]));

async function fixture(t, options) {
  const f = await createAnnouncementReadFixture(options);
  t.after(() => f.close());
  return f;
}
async function ownedFixture(t) {
  const ws = createSyntheticWorkspace();
  let f, live;
  t.after(async () => { if (live) await live.close(); if (f) await f.close(); disposeSyntheticWorkspace(ws); });
  f = await createAnnouncementReadFixture({ workspace: ws });
  return { ws, f, setLive(value) { live = value; } };
}
async function expectError(f, client, method, url, body, status, code, headers) {
  const response = await f.request(client, method, url, body, headers);
  assert.equal(response.status, status, 'Expected bounded HTTP error status');
  assert.equal(response.body.error.code, code, 'Expected bounded HTTP error code');
  return response;
}
function checkReceipt(receipt, item, client, { name = client.user.name, role = client.role } = {}) {
  same(Object.keys(receipt).sort(), [...RECEIPT_KEYS].sort(), 'Only the eight receipt fields are returned');
  assert.equal(receipt.id, receiptId(client.org, item.id, item.version, client.user.id));
  assert.match(receipt.id, /^[a-f0-9]{64}$/);
  same([receipt.orgId, receipt.announcementId, receipt.announcementVersion, receipt.userId, receipt.userName, receipt.role],
    [client.org, item.id, item.version, client.user.id, name, role], 'Receipt represents the exact authenticated tuple and saved name/role');
  assert(canonicalTime(receipt.readAt), 'Read time is canonical server ISO');
}
function checkStoredReceipt(f, receipt) {
  const locator = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(receipt.id);
  same([locator.org_id, locator.entity, locator.data, locator.version, locator.created_at, locator.updated_at],
    [receipt.orgId, 'announcement-reads', '{}', 1, receipt.readAt, receipt.readAt], 'Locator contains only its fixed FK identity and metadata');
  const row = f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=?').get(receipt.id);
  const snapshot = JSON.parse(row.snapshot);
  same(Object.keys(snapshot).sort(), [...SNAPSHOT_KEYS].sort(), 'Immutable snapshot has exactly eleven fields');
  same(snapshot, { ...receipt, version: 1, createdAt: receipt.readAt, updatedAt: receipt.readAt }, 'Immutable snapshot is the full saved receipt');
  same([row.org_id, row.entity, row.version, row.created_at, row.source],
    [receipt.orgId, 'announcement-reads', 1, receipt.readAt, 'announcement.read'], 'Snapshot SQL metadata and source match');
  const audits = f.app.db.prepare("SELECT * FROM audit WHERE action='announcement.read' AND org_id=? AND record_id=?").all(receipt.orgId, receipt.announcementId)
    .filter(row => JSON.parse(row.detail).receiptId === receipt.id);
  assert.equal(audits.length, 1);
  same([audits[0].entity, audits[0].user_id, JSON.parse(audits[0].detail)],
    ['announcements', receipt.userId, { version: receipt.announcementVersion, receiptId: receipt.id }], 'One bounded receipt audit uses the announcement without changing its actor history');
}

test('every fresh GET preserves full typed state and viewing never creates an implicit acknowledgement', async t => {
  const f = await fixture(t), item = f.announcements.all, before = savedState(f);
  for (const role of ROLES) {
    const client = f.clients[role];
    for (const url of [route(item), route(item) + '/history', route(item) + '/history?compare=previous']) assert.equal((await f.request(client, 'GET', url)).status, 200);
    const result = await f.request(client, 'GET', stateRoute(item));
    assert.equal(result.status, 200);
    same(Object.keys(result.body).sort(), ['announcement', 'currentVersion', 'canAcknowledge', 'receipt'].sort(), 'Read state has the four contract fields');
    same(result.body, { announcement: projectedAnnouncement(item), currentVersion: 1, canAcknowledge: true, receipt: null }, 'Fresh current published text is unread');
    if (['admin', 'supervisor'].includes(role)) {
      const roster = await f.request(client, 'GET', rosterRoute(item));
      same(roster.body, { announcement: projectedAnnouncement(item), currentVersion: 1, items: [], total: 0, page: 1, pageSize: 25 }, 'Empty roster does not infer readers or completion');
    }
  }
  unchanged(f, before, 'GET paths do not write any of the eleven tables or counters');
  assert.equal(f.counts().tableCount, 11); assert.equal(f.counts().triggerCount, 6);
});

test('all four roles explicitly save one exact immutable receipt while raw announcement text and actor history remain unchanged', async t => {
  const f = await fixture(t), item = f.announcements.all;
  const history = (await f.request(f.clients.admin, 'GET', route(item) + '/history?compare=previous')).body;
  for (const role of ROLES) {
    const client = f.clients[role], before = f.counts();
    const response = await f.request(client, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': 'ack-four-' + role });
    assert.equal(response.status, 201); same(Object.keys(response.body), ['receipt'], 'POST only returns receipt');
    checkReceipt(response.body.receipt, item, client); checkStoredReceipt(f, response.body.receipt);
    const after = f.counts();
    assert.equal(after.totalChanges - before.totalChanges, 4);
    for (const table of ['records', 'record_versions', 'audit', 'idempotency']) assert.equal(after.tables[table] - before.tables[table], 1);
    same((await f.request(client, 'GET', stateRoute(item))).body.receipt, response.body.receipt, 'Only this caller own receipt is returned');
  }
  same((await f.request(f.clients.admin, 'GET', route(item))).body.item, item, 'Acknowledgement does not rewrite the announcement');
  same((await f.request(f.clients.admin, 'GET', route(item) + '/history?compare=previous')).body, history, 'announcement.read audits do not invent version actors');
});

test('draft and audience scopes preserve existing read rights and nonempty raw whitespace is acknowledgeable without trimming', async t => {
  const f = await fixture(t), before = savedState(f);
  for (const role of ['admin', 'supervisor', 'finance']) {
    const client = f.clients[role], state = await f.request(client, 'GET', stateRoute(f.announcements.draft));
    assert.equal(state.status, 200); assert.equal(state.body.canAcknowledge, false); assert.equal(state.body.receipt, null);
    await expectError(f, client, 'POST', stateRoute(f.announcements.draft), { version: 1 }, 422, 'ANNOUNCEMENT_NOT_PUBLISHED');
    assert.equal((await f.request(client, 'GET', stateRoute(f.announcements.finance))).status, 200);
  }
  for (const item of [f.announcements.draft, f.announcements.finance]) for (const method of ['GET', 'POST']) await expectError(f, f.clients.caregiver, method, stateRoute(item), method === 'POST' ? { version: 1 } : undefined, 404, 'NOT_FOUND');
  unchanged(f, before, 'Denied acknowledgement and allowed draft reads write nothing');
  const whitespace = await f.create('announcements', { title: ' ', body: '\n', audience: 'all', status: 'published' });
  checkReceipt(await f.ack(whitespace, f.clients.finance), whitespace, f.clients.finance);
});

test('a new published version including no-op edit starts unread and same-key stale replay cannot acknowledge the new version', async t => {
  const f = await fixture(t), first = f.announcements.all;
  const receipt = await f.ack(first, f.clients.caregiver, { key: 'version-one-only' });
  const current = await f.patch('announcements', first, {}), before = savedState(f);
  const state = (await f.request(f.clients.caregiver, 'GET', stateRoute(current))).body;
  assert.equal(state.currentVersion, 2); assert.equal(state.receipt, null); assert.equal(state.canAcknowledge, true);
  const old = (await f.request(f.clients.caregiver, 'GET', stateRoute(current, 'version=1'))).body;
  same(old.receipt, receipt, 'Historical receipt remains saved for its exact version'); assert.equal(old.canAcknowledge, false);
  await expectError(f, f.clients.caregiver, 'POST', stateRoute(current), { version: 1 }, 409, 'VERSION_CONFLICT', { 'Idempotency-Key': 'version-one-only' });
  unchanged(f, before, 'Stale current preflight runs before cached replay and creates no new row');
  const second = await f.ack(current, f.clients.caregiver, { key: 'version-two-only' });
  assert.notEqual(second.id, receipt.id); checkStoredReceipt(f, receipt); checkStoredReceipt(f, second);
});

test('withdrawal and audience changes revoke caregiver current and historical reads before replay while admin retains historical receipts', async t => {
  const f = await fixture(t), first = f.announcements.all, receipt = await f.ack(first, f.clients.caregiver, { key: 'revoked-prior' });
  let current = await f.patch('announcements', first, { status: 'draft' });
  for (const patch of [null, { status: 'published', audience: 'finance' }]) {
    if (patch) current = await f.patch('announcements', current, patch);
    const before = savedState(f);
    for (const url of [stateRoute(current), stateRoute(current, 'version=1')]) await expectError(f, f.clients.caregiver, 'GET', url, undefined, 404, 'NOT_FOUND');
    await expectError(f, f.clients.caregiver, 'GET', rosterRoute(current, 'version=1'), undefined, 403, 'ROLE_FORBIDDEN');
    await expectError(f, f.clients.caregiver, 'POST', stateRoute(current), { version: 1 }, 404, 'NOT_FOUND', { 'Idempotency-Key': 'revoked-prior' });
    same((await f.request(f.clients.admin, 'GET', stateRoute(current, 'version=1'))).body.receipt, null, 'Admin own state does not return caregiver receipt');
    same((await f.request(f.clients.admin, 'GET', rosterRoute(current, 'version=1'))).body.items, [receipt], 'Authorized exact old version keeps its real receipt');
    unchanged(f, before, 'Withdrawal denies replay without deleting the receipt');
  }
  current = await f.patch('announcements', current, { audience: 'caregiver' });
  const restored = (await f.request(f.clients.caregiver, 'GET', stateRoute(current, 'version=1'))).body;
  same(restored.receipt, receipt, 'Original readable version is visible again without a new receipt');
  assert.equal((await f.request(f.clients.caregiver, 'GET', stateRoute(current))).body.receipt, null);
});

test('authentication, exact organization and active caregiver membership are checked on every read, submit and replay', async t => {
  const f = await fixture(t), item = f.announcements.all;
  await f.ack(item, f.clients.caregiver, { key: 'active-link-prior' });
  let before = savedState(f);
  for (const method of ['GET', 'POST']) {
    const body = method === 'POST' ? { version: 1 } : undefined;
    await expectError(f, null, method, stateRoute(item), body, 401, 'AUTH_REQUIRED');
    await expectError(f, { ...f.clients.admin, org: '' }, method, stateRoute(item), body, 400, 'ORG_REQUIRED');
    await expectError(f, { ...f.clients.supervisor, org: f.orgIds.foreign }, method, stateRoute(item), body, 403, 'ORG_FORBIDDEN');
    await expectError(f, { ...f.clients.admin, org: f.orgIds.foreign }, method, stateRoute(item), body, 404, 'NOT_FOUND');
    for (const target of [f.announcements.foreign, { id: randomUUID() }, f.actors.caregiver.employee]) await expectError(f, f.clients.admin, method, stateRoute(target), body, 404, 'NOT_FOUND');
  }
  unchanged(f, before, 'Auth/scope rejection writes no rows');
  await f.patch('employees', f.actors.caregiver.employee, { status: 'inactive' }); before = savedState(f);
  for (const method of ['GET', 'POST']) await expectError(f, f.clients.caregiver, method, stateRoute(item), method === 'POST' ? { version: 1 } : undefined, 403, 'EMPLOYEE_LINK_REQUIRED', { 'Idempotency-Key': 'active-link-prior' });
  unchanged(f, before, 'Inactive employee cannot replay an earlier success');
});

test('Origin, CSRF, body validation, caller identity spoofing and unsupported methods retain exact bounded errors and zero writes', async t => {
  const f = await fixture(t), item = f.announcements.all, before = savedState(f);
  for (const csrf of ['', 'invalid', 'é'.repeat(64)]) await expectError(f, f.clients.admin, 'POST', stateRoute(item), { version: 1 }, 403, 'CSRF_INVALID', { 'X-CSRF-Token': csrf });
  await expectError(f, f.clients.admin, 'POST', stateRoute(item), { version: 1 }, 403, 'ORIGIN_FORBIDDEN', { Origin: 'https://untrusted.example.test' });
  await expectError(f, f.clients.admin, 'POST', stateRoute(item), { version: 1 }, 415, 'CONTENT_TYPE', { 'Content-Type': 'text/plain' });
  for (const version of [undefined, 0, -1, 1.1, '1', null, Number.MAX_SAFE_INTEGER + 1]) await expectError(f, f.clients.admin, 'POST', stateRoute(item), version === undefined ? {} : { version }, 422, 'VERSION_REQUIRED');
  for (const field of ['userId', 'userName', 'role', 'readAt', 'orgId', 'announcementId']) await expectError(f, f.clients.admin, 'POST', stateRoute(item), { version: 1, [field]: 'caller-spoof' }, 422, 'UNKNOWN_FIELD');
  for (const [method, url] of [['PATCH', stateRoute(item)], ['DELETE', stateRoute(item)], ['POST', rosterRoute(item)], ['PUT', rosterRoute(item)]]) await expectError(f, f.clients.admin, method, url, {}, 405, 'METHOD_NOT_ALLOWED');
  await expectError(f, f.clients.admin, 'PATCH', stateRoute(item), {}, 403, 'CSRF_INVALID', { 'X-CSRF-Token': '' });
  unchanged(f, before, 'All rejected paths preserve durable data and counters');
});

test('same key repeats exact response without writes, new key duplicate writes only its ledger, and no-key duplicate writes nothing', async t => {
  const f = await fixture(t), item = f.announcements.all, client = f.clients.finance;
  const first = await f.request(client, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': 'once-key' });
  assert.equal(first.status, 201); const before = savedState(f);
  const replay = await f.request(client, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': 'once-key' });
  assert.equal(replay.status, 201); same(replay.bytes, first.bytes, 'Same-key original status and response bytes are preserved'); unchanged(f, before, 'Same-key replay is zero-write');
  await expectError(f, client, 'POST', stateRoute(f.announcements.caregiver), { version: 1 }, 409, 'IDEMPOTENCY_CONFLICT', { 'Idempotency-Key': 'once-key' }); unchanged(f, before, 'Same key cannot be reused for another announcement');
  for (const key of ['é', 'x'.repeat(129)]) await expectError(f, client, 'POST', stateRoute(item), { version: 1 }, 422, 'IDEMPOTENCY_KEY', { 'Idempotency-Key': key });
  const duplicate = await f.request(client, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': 'new-key' });
  assert.equal(duplicate.status, 200); same(duplicate.body.receipt, first.body.receipt, 'New key preserves original read time and identity');
  const after = savedState(f); assert.equal(after.counts.totalChanges - before.counts.totalChanges, 1);
  for (const table of Object.keys(before.counts.tables)) assert.equal(after.counts.tables[table] - before.counts.tables[table], table === 'idempotency' ? 1 : 0);
  const noKey = await f.request(client, 'POST', stateRoute(item), { version: 1 }); assert.equal(noKey.status, 200); same(noKey.body.receipt, first.body.receipt, 'No-key duplicate returns original receipt'); unchanged(f, after, 'No-key duplicate is zero-write');
});

test('two concurrent new keys serialize one tuple and distinct users receive full independent SHA identities', async t => {
  const f = await fixture(t), item = f.announcements.all, client = f.clients.caregiver, before = f.counts();
  const results = await Promise.all(['parallel-a', 'parallel-b'].map(key => f.request(client, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': key })));
  same(results.map(result => result.status).sort(), [200, 201], 'Only one concurrent request creates the tuple');
  same(results[0].body.receipt, results[1].body.receipt, 'Both requests return the same immutable receipt');
  const after = f.counts(); assert.equal(after.totalChanges - before.totalChanges, 5);
  for (const table of ['records', 'record_versions', 'audit']) assert.equal(after.tables[table] - before.tables[table], 1);
  assert.equal(after.tables.idempotency - before.tables.idempotency, 2);
  const own = results[0].body.receipt, other = await f.ack(item, f.clients.caregiver2);
  assert.notEqual(own.id, other.id); checkReceipt(own, item, client); checkReceipt(other, item, f.clients.caregiver2);
  same((await f.request(client, 'GET', stateRoute(item))).body.receipt, own, 'GET cannot return another caller receipt');
});

test('complete typed heads are readable but unacknowledgeable, missing or mismatched current heads fail closed without repairing legacy GET', async t => {
  const f = await fixture(t);
  for (const fields of [{ title: '' }, { body: '' }, { title: null }, { body: { typed: 'object' } }, { title: 17 }, { body: ['text'] }]) {
    const item = f.importAnnouncement(fields), before = savedState(f), response = await f.request(f.clients.admin, 'GET', stateRoute(item));
    assert.equal(response.status, 200); assert.equal(response.body.canAcknowledge, false);
    same(response.body.announcement, projectedAnnouncement(item), 'Typed imported text remains its exact saved value');
    await expectError(f, f.clients.admin, 'POST', stateRoute(item), { version: 1 }, 422, 'ANNOUNCEMENT_NOT_READABLE');
    unchanged(f, before, 'Typed head is never coerced, repaired or acknowledged');
  }
  const item = f.announcements.all, original = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data;
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(original), body: 'changed-without-snapshot' }), item.id);
  let before = savedState(f);
  for (const method of ['GET', 'POST']) await expectError(f, f.clients.admin, method, stateRoute(item), method === 'POST' ? { version: 1 } : undefined, 409, 'ANNOUNCEMENT_VERSION_INVALID');
  assert.equal((await f.request(f.clients.admin, 'GET', route(item))).status, 200); unchanged(f, before, 'New validation does not change legacy current GET or repair mismatch');
  f.app.db.prepare('UPDATE records SET data=?,version=2 WHERE id=?').run(original, item.id); before = savedState(f);
  await expectError(f, f.clients.admin, 'GET', stateRoute(item), undefined, 409, 'ANNOUNCEMENT_VERSION_INVALID'); unchanged(f, before, 'Missing current head stays missing');
  f.app.db.prepare('UPDATE records SET data=?,version=1 WHERE id=?').run(original + '\0SYNTHETIC-NUL-SUFFIX', item.id); before = savedState(f);
  for (const method of ['GET', 'POST']) await expectError(f, f.clients.admin, method, stateRoute(item), method === 'POST' ? { version: 1 } : undefined, 409, 'ANNOUNCEMENT_VERSION_INVALID');
  unchanged(f, before, 'A valid JSON prefix followed by stored NUL is not truncated into a valid head');
  f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(original, 9223372036854775807n, item.id); before = savedState(f);
  for (const method of ['GET', 'POST']) await expectError(f, f.clients.admin, method, stateRoute(item), method === 'POST' ? { version: 1 } : undefined, 409, 'ANNOUNCEMENT_VERSION_INVALID');
  unchanged(f, before, 'Oversized saved SQL int64 is a sanitized invalid head rather than a driver RangeError');
});

test('new canonical query parsing rejects duplicate/unknown/unsafe values and explicit visible future history is not artificially capped', async t => {
  const f = await fixture(t), item = f.announcements.all, before = savedState(f);
  for (const query of ['version=', 'version=0', 'version=01', 'version=+1', 'version=1.0', 'version=1e0', 'version=-1', 'version=9007199254740992', 'version=1&version=1', 'userId=x', 'page=1', '__proto__=x']) await expectError(f, f.clients.admin, 'GET', stateRoute(item, query), undefined, 422, 'ANNOUNCEMENT_READ_QUERY');
  for (const query of ['version=1', 'version=1&version=1', 'unknown=x']) await expectError(f, f.clients.admin, 'POST', stateRoute(item, query), { version: 1 }, 422, 'ANNOUNCEMENT_READ_QUERY');
  for (const query of ['page=01', 'page=0', 'pageSize=101', 'pageSize=', 'page=1&page=2', 'pageSize=25&pageSize=25', 'page=9007199254740991&pageSize=100']) await expectError(f, f.clients.admin, 'GET', rosterRoute(item, query), undefined, 422, 'PAGINATION');
  for (const query of ['unknown=x', 'version=1&version=2', 'version=01']) await expectError(f, f.clients.admin, 'GET', rosterRoute(item, query), undefined, 422, 'ANNOUNCEMENT_READ_QUERY');
  await expectError(f, f.clients.admin, 'GET', stateRoute(item, 'version=9007199254740991'), undefined, 404, 'NOT_FOUND'); unchanged(f, before, 'Invalid queries and absent versions create no writes');
  const time = new Date().toISOString(), future = { ...item, version: 9, updatedAt: time };
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.orgIds.own, 'announcements', item.id, 9, JSON.stringify(future), time, 'baseline');
  const futureBefore = savedState(f), result = await f.request(f.clients.caregiver, 'GET', stateRoute(item, 'version=9'));
  assert.equal(result.status, 200); assert.equal(result.body.currentVersion, 1); assert.equal(result.body.announcement.version, 9); assert.equal(result.body.canAcknowledge, false); assert.equal(result.body.receipt, null);
  unchanged(f, futureBefore, 'Visible saved future version follows existing history without synthetic writes');
});

test('only admin/supervisor can page actual version receipts in stable order without exposing current names or a cohort', async t => {
  const f = await fixture(t), item = f.announcements.all;
  const added = await f.addReaders(27), expected = [...added.receipts].sort((a, b) => b.readAt.localeCompare(a.readAt) || a.id.localeCompare(b.id)), before = savedState(f);
  for (const role of ['admin', 'supervisor']) {
    const first = await f.request(f.clients[role], 'GET', rosterRoute(item)), second = await f.request(f.clients[role], 'GET', rosterRoute(item, 'version=1&page=2&pageSize=25'));
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    same(Object.keys(first.body).sort(), ['announcement', 'currentVersion', 'items', 'total', 'page', 'pageSize'].sort(), 'Roster has only six bounded contract fields');
    same(first.body.items, expected.slice(0, 25), 'Page one follows readAt DESC/id ASC'); same(second.body.items, expected.slice(25), 'Page two has the remaining actual receipts');
    assert.equal(first.body.total, 27); assert.equal(second.body.page, 2);
    assert.equal((await f.request(f.clients[role], 'GET', rosterRoute(f.announcements.caregiver))).body.total, 0);
  }
  for (const role of ['finance', 'caregiver']) await expectError(f, f.clients[role], 'GET', rosterRoute(item), undefined, 403, 'ROLE_FORBIDDEN');
  unchanged(f, before, 'Pagination and forbidden roster access preserve every table');
});

test('hidden locators have no generic CRUD/history API and immutable receipts retain reading-time empty/name/role through later identity changes', async t => {
  const f = await fixture(t), item = f.announcements.all, client = f.clients.finance;
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('', client.user.id);
  const receipt = await f.ack(item, client); checkReceipt(receipt, item, client, { name: '' });
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成後來改名', client.user.id);
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', f.orgIds.own, client.user.id);
  const before = savedState(f);
  same((await f.request(client, 'GET', stateRoute(item))).body.receipt, receipt, 'Saved reading-time name/role are not joined to current identity');
  same(await f.ack(item, client), receipt, 'Legal duplicate retains original empty name and finance role');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) for (const url of ['/api/announcement-reads', '/api/announcement-reads/' + receipt.id, '/api/announcement-reads/' + receipt.id + '/history']) await expectError(f, f.clients.admin, method, url, method === 'GET' ? undefined : { version: 1 }, 404, 'NOT_FOUND');
  const originalLocator = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(receipt.id).data;
  assert.equal(originalLocator, '{}'); unchanged(f, before, 'Generic endpoints and duplicate do not write hidden locators');
  for (const sql of ['UPDATE record_versions SET snapshot=snapshot WHERE record_id=?', 'DELETE FROM record_versions WHERE record_id=?']) assert.throws(() => f.app.db.prepare(sql).run(receipt.id), /immutable/);
  const afterFailure = savedState(f); same(afterFailure.digest, before.digest, 'Original six triggers preserve immutable receipt bytes');
});

test('locator/audit/cache are not truth and cached forged envelopes or malformed JSON cannot replay an invented receipt', async t => {
  const f = await fixture(t), item = f.announcements.all, client = f.clients.admin, receipt = await f.ack(item, client, { key: 'truth-key' });
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ receipt: 'not-the-truth' }), receipt.id);
  let before = savedState(f);
  same((await f.request(client, 'GET', stateRoute(item))).body.receipt, receipt, 'Mutable locator data does not redefine the receipt');
  same(await f.ack(item, client), receipt, 'Duplicate uses immutable snapshot despite locator data'); unchanged(f, before, 'Locator payload is never rewritten as repair');
  const poisoned = [JSON.stringify({ receipt: { ...receipt, userName: 'FORGED-CACHE-SECRET' } }), JSON.stringify({ receipt, extra: 'FORGED-CACHE-SECRET' }), '{FORGED-CACHE-SECRET', JSON.stringify({ receipt }) + '\0suffix'];
  for (const value of poisoned) {
    f.app.db.prepare('UPDATE idempotency SET response=? WHERE org_id=? AND user_id=? AND key=?').run(value, client.org, client.user.id, 'truth-key'); before = savedState(f);
    const error = await expectError(f, client, 'POST', stateRoute(item), { version: 1 }, 409, 'ANNOUNCEMENT_RECEIPT_INVALID', { 'Idempotency-Key': 'truth-key' });
    assert(!error.bytes.toString('utf8').includes('FORGED-CACHE-SECRET'), 'Cached raw bytes are not leaked in bounded error');
    same((await f.request(client, 'GET', stateRoute(item))).body.receipt, receipt, 'GET never trusts poisoned cache'); unchanged(f, before, 'Invalid cache is neither replayed nor silently repaired');
  }
  f.app.db.prepare('UPDATE idempotency SET response=?,status=? WHERE org_id=? AND user_id=? AND key=?').run(JSON.stringify({ receipt }), 503, client.org, client.user.id, 'truth-key'); before = savedState(f);
  await expectError(f, client, 'POST', stateRoute(item), { version: 1 }, 409, 'ANNOUNCEMENT_RECEIPT_INVALID', { 'Idempotency-Key': 'truth-key' });
  unchanged(f, before, 'An invalid cached success status cannot confirm immutable truth');
  f.app.db.prepare('UPDATE idempotency SET response=?,status=? WHERE org_id=? AND user_id=? AND key=?').run(JSON.stringify({ receipt }), 9223372036854775807n, client.org, client.user.id, 'truth-key'); before = savedState(f);
  await expectError(f, client, 'POST', stateRoute(item), { version: 1 }, 409, 'ANNOUNCEMENT_RECEIPT_INVALID', { 'Idempotency-Key': 'truth-key' });
  unchanged(f, before, 'An oversized SQL status fails closed without durable or counter changes');
  for (const variant of ['missing-head', 'baseline', 'bad-tuple', 'extra-key', 'bad-time', 'row-time', 'snapshot-nul', 'source-nul', 'entity-nul', 'sql-version-oversized']) {
    const bad = await createAnnouncementReadFixture();
    try {
      const target = bad.announcements.all, caller = bad.clients.admin, time = new Date().toISOString(), id = receiptId(caller.org, target.id, 1, caller.user.id);
      const snapshot = { id, orgId: caller.org, version: 1, createdAt: time, updatedAt: time, announcementId: target.id, announcementVersion: 1, userId: caller.user.id, userName: caller.user.name, role: caller.role, readAt: time };
      if (variant === 'bad-tuple') snapshot.userId = randomUUID();
      if (variant === 'extra-key') snapshot.secret = 'SYNTHETIC-PRIVATE-RECEIPT';
      if (variant === 'bad-time') snapshot.readAt = '2026-10-09';
      bad.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, caller.org, 'announcement-reads', '{}', 1, time, time);
      if (variant !== 'missing-head') bad.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(
        caller.org, variant === 'entity-nul' ? 'announcement-reads\0SYNTHETIC-NUL-SUFFIX' : 'announcement-reads', id,
        variant === 'sql-version-oversized' ? 9223372036854775807n : 1,
        JSON.stringify(snapshot) + (variant === 'snapshot-nul' ? '\0SYNTHETIC-NUL-SUFFIX' : ''),
        variant === 'row-time' ? new Date(Date.parse(time) + 1).toISOString() : time,
        variant === 'baseline' ? 'baseline' : variant === 'source-nul' ? 'announcement.read\0SYNTHETIC-NUL-SUFFIX' : 'announcement.read');
      const stable = savedState(bad);
      for (const method of ['GET', 'POST']) await expectError(bad, caller, method, stateRoute(target), method === 'POST' ? { version: 1 } : undefined, 409, 'ANNOUNCEMENT_RECEIPT_INVALID');
      unchanged(bad, stable, 'Invalid immutable tuple is not absence and cannot create another receipt');
    } finally { await bad.close(); }
  }
});

test('a TEMP last-ledger insertion failure rolls back all durable receipt rows and permits explicit same-key retry', async t => {
  const f = await fixture(t), item = f.announcements.all, before = savedState(f);
  f.app.db.exec("CREATE TEMP TRIGGER synthetic_ack_last_write_fail BEFORE INSERT ON idempotency WHEN NEW.key='atomic-ack-key' BEGIN SELECT RAISE(ABORT,'Synthetic last ledger failure'); END;");
  try {
    const failed = await f.request(f.clients.admin, 'POST', stateRoute(item), { version: 1 }, { 'Idempotency-Key': 'atomic-ack-key' });
    assert.equal(failed.status, 500);
  } finally { f.app.db.exec('DROP TRIGGER synthetic_ack_last_write_fail'); }
  const rolled = savedState(f); assert.equal(rolled.digest, before.digest, 'Locator, immutable snapshot, audit and ledger all roll back');
  same(rolled.counts.tables, before.counts.tables, 'Rollback leaves no durable orphan locator');
  assert.equal(rolled.counts.totalChanges - before.counts.totalChanges, 3, 'SQLite counters include the three attempted rolled-back writes');
  assert.equal(rolled.counts.tableCount, 11); assert.equal(rolled.counts.triggerCount, 6);
  const receipt = await f.ack(item, f.clients.admin, { key: 'atomic-ack-key' }); checkStoredReceipt(f, receipt);
  assert.equal(f.counts().totalChanges - rolled.counts.totalChanges, 4);
});

test('receipt operations preserve two BLOBs, all approved raw pricing snapshots and all 31 existing report outlets', async t => {
  const { f } = await ownedFixture(t), month = f.baseFixture.month, year = month.slice(0, 4);
  assert.equal(f.baseFixtureChanges, 109, 'Sealed v039 source fixture writes are separately accounted');
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=${month}`, `/api/reports/${kind}.csv?month=${month}`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=${year}-01-01&endDate=${year}-12-31${kind === 'certification' ? '&asOf=' + month + '-01' : ''}`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix);
  assert.equal(routes.length, 31);
  async function reportState() {
    const output = [];
    for (const url of routes) {
      const response = await f.request(f.clients.admin, 'GET', url); assert.equal(response.status, 200, 'Existing report outlet remains available');
      output.push(typeof response.body === 'string' ? sha(response.bytes) : Object.fromEntries(Object.entries(response.body).filter(([key]) => key !== 'generatedAt')));
    }
    return output;
  }
  const beforeReports = await reportState(), raw = f.rawState();
  for (const role of ROLES) await f.ack(f.announcements.all, f.clients[role], { key: 'report-preservation-' + role });
  const stable = savedState(f); same(await reportState(), beforeReports, 'Receipts do not change any report rows, totals or raw CSV bytes');
  const after = f.rawState();
  for (const table of ['attachment_files', 'certification_attachment_files']) same(after.typedTables[table], raw.typedTables[table], 'Both nonempty attachment BLOB versions retain exact bytes and metadata');
  const serviceRows = state => state.tables.records.filter(row => row.entity === 'service-records');
  same(serviceRows(after), serviceRows(raw), 'Approved saved service envelopes and pricing snapshots remain exact');
  for (const [entity, item, expected] of [['case-attachments', f.baseFixture.items.caseAttachment, f.baseFixture.expected.caseBytes], ['certification-attachments', f.baseFixture.items.certAttachment, f.baseFixture.expected.certBytes]]) {
    const response = await f.request(f.clients.admin, 'GET', `/api/${entity}/${item.id}/download`); assert.equal(response.status, 200); assert.equal(sha(response.bytes), sha(expected));
  }
  unchanged(f, stable, 'All report and file reads leave the eleven tables and counters unchanged');
});

test('committed receipts in WAL survive capture/restore with full rows, sessions and zero-write startup', async t => {
  const { ws, f, setLive } = await ownedFixture(t), item = f.announcements.all;
  const checkpoint = f.app.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); assert.equal(checkpoint.busy, 0);
  const sourcePath = syntheticDatabasePath(ws, 'source'), mainBefore = sha(readFileSync(sourcePath));
  const receipt = await f.ack(item, f.clients.caregiver, { key: 'wal-receipt-only' }); checkStoredReceipt(f, receipt);
  assert.equal(sha(readFileSync(sourcePath)), mainBefore, 'Receipt commit remains after checkpoint in WAL, not stale main');
  assert(readFileSync(sourcePath + '-wal').length > 32, 'Committed receipt WAL has frames');
  const source = savedState(f), reference = captureSyntheticBackup(ws);
  unchanged(f, source, 'Capture preserves every source field and counter');
  restoreSyntheticBackup(ws, reference, 'live');
  const summary = inspectSyntheticDatabase(ws, 'live'); assert.equal(summary.tableCount, 11); assert.equal(summary.triggerCount, 6);
  const live = createApp({ dbPath: syntheticDatabasePath(ws, 'live'), host: '127.0.0.1', port: 0 }); setLive(live);
  assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0, 'Complete receipt version prevents startup baseline repair');
  assert.equal(rawDigest(readSyntheticRawState(live.db)), source.digest, 'All persisted receipt/audit/idem/session/BLOB fields roundtrip exactly');
  const base = await live.listen(), client = f.clients.caregiver;
  const response = await fetch(base + stateRoute(item), { headers: { Cookie: client.cookie, 'X-Org-Id': client.org } });
  assert.equal(response.status, 200); same((await response.json()).receipt, receipt, 'Original valid session reads its restored own exact receipt');
  assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0, 'Restored read does not write or relogin');
  unchanged(f, source, 'Restored read has no source effects');
});

test('distinct receipt generations retain exact closed bytes through forced rollback and successful promotion keeps previous', async t => {
  const { ws, f, setLive } = await ownedFixture(t), first = f.announcements.all;
  const firstReceipt = await f.ack(first, f.clients.finance, { key: 'generation-a-receipt' }), generationA = savedState(f), reference = captureSyntheticBackup(ws);
  restoreSyntheticBackup(ws, reference, 'live');
  const livePath = syntheticDatabasePath(ws, 'live');
  let live = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 }); setLive(live); let base = await live.listen();
  const client = f.clients.admin;
  const headers = { Origin: base, Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org, 'Content-Type': 'application/json' };
  const changed = await fetch(base + route(first), { method: 'PATCH', headers, body: JSON.stringify({ version: 1, body: '合成第二代新公告原文' }) }); assert.equal(changed.status, 200); const current = (await changed.json()).item;
  const acknowledged = await fetch(base + stateRoute(current), { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'generation-b-receipt' }, body: JSON.stringify({ version: 2 }) }); assert.equal(acknowledged.status, 201); const secondReceipt = (await acknowledged.json()).receipt;
  assert.notEqual(secondReceipt.id, firstReceipt.id);
  const generationB = rawDigest(readSyntheticRawState(live.db)); assert.notEqual(generationB, generationA.digest);
  await live.close(); setLive(null); const closedB = sha(readFileSync(livePath));
  restoreSyntheticBackup(ws, reference, 'staged');
  const rollback = promoteSyntheticRestore(ws, { forceRollback: true }); assert.equal(rollback.status, 'rolled_back'); assert.equal(sha(readFileSync(livePath)), closedB);
  live = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 }); setLive(live);
  assert.equal(rawDigest(readSyntheticRawState(live.db)), generationB, 'Rollback restores the whole different original live receipt generation'); assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0);
  base = await live.listen();
  const rolledResponse = await fetch(base + stateRoute(current), { headers: { Cookie: client.cookie, 'X-Org-Id': client.org } }); assert.equal(rolledResponse.status, 200);
  same((await rolledResponse.json()).receipt, secondReceipt, 'Rolled-back live exposes its own second-version receipt');
  assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0);
  await live.close(); setLive(null);
  const promotion = promoteSyntheticRestore(ws, { forceRollback: false }); assert.equal(promotion.status, 'promoted'); assert.equal(sha(readFileSync(syntheticDatabasePath(ws, 'previous'))), closedB);
  live = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 }); setLive(live);
  assert.equal(rawDigest(readSyntheticRawState(live.db)), generationA.digest, 'Promotion exposes the candidate original receipt generation'); assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0);
  base = await live.listen(); const finance = f.clients.finance;
  const promotedResponse = await fetch(base + stateRoute(first), { headers: { Cookie: finance.cookie, 'X-Org-Id': finance.org } }); assert.equal(promotedResponse.status, 200);
  same((await promotedResponse.json()).receipt, firstReceipt, 'Promoted live exposes its original first-version reading state');
  assert.equal(live.db.prepare('SELECT total_changes() AS n').get().n, 0);
  assert.equal(promotion.live.tableCount, 11); assert.equal(promotion.live.triggerCount, 6);
  unchanged(f, generationA, 'Both switches preserve the captured source generation and counters');
});
