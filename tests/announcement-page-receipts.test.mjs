import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { announcementPageIdentity, captureAnnouncementPage, confirmAnnouncementPageSnapshot,
  projectAnnouncementPageReadState } from '../public/data/announcement-page-receipts.js';

const orgId = 'synthetic-org';
const userId = 'synthetic-owner';
const recordId = 'aa-01';
const time = '2026-10-10T01:02:03.004Z';
const requested = (page = 1) => ({ page, pageSize: 25, orgId });
const row = (id = recordId) => ({ id, orgId, version: 1, createdAt: time, updatedAt: time });
const page = (items = [row()], total = items.length, number = 1) => ({ items, total, page: number, pageSize: 25 });
const expected = () => ({ id: recordId, orgId, userId });
function state(version = 1) {
  return {
    announcement: { id: recordId, orgId, version, createdAt: time, updatedAt: time,
      title: '合成公告', body: '合成完整內容', audience: 'all', status: 'published' },
    currentVersion: version, canAcknowledge: true, receipt: null,
  };
}
function receipt(version = 1, overrides = {}) {
  return { id: createHash('sha256').update(JSON.stringify([
    'suiyue-announcement-read-v1', orgId, recordId, version, userId,
  ])).digest('hex'), orgId, announcementId: recordId, announcementVersion: version,
  userId, userName: '閱讀時合成名稱', role: 'finance', readAt: time, ...overrides };
}
const rejectsCapture = value => assert.throws(() => captureAnnouncementPage(value, requested()));

test('complete primitive identity follows nested values and preserves delimiter distinctions', () => {
  const context = { user: { id: 'a:b', employeeId: 'ee' }, organizationId: orgId, role: 'admin' };
  assert.equal(announcementPageIdentity(context), JSON.stringify(['a:b', orgId, 'admin', 'ee']));
  assert.equal(announcementPageIdentity({ ...context, user: { ...context.user } }), announcementPageIdentity(context));
  for (const changed of [
    { ...context, user: { ...context.user, id: 'a' } }, { ...context, organizationId: 'other' },
    { ...context, role: 'finance' }, { ...context, user: { ...context.user, employeeId: 'other' } },
  ]) assert.notEqual(announcementPageIdentity(changed), announcementPageIdentity(context));
  assert.equal(announcementPageIdentity({ user: null, organizationId: null, orgId, role: 'caregiver' }), JSON.stringify([null, orgId, 'caregiver', null]));
  assert.equal(announcementPageIdentity({ organizationId: '', orgId }), JSON.stringify([null, '', null, null]));
  assert.equal(announcementPageIdentity(null), '[null,null,null,null]');
});

test('identity rejects known accessor and nonprimitive values without execution', () => {
  let called = 0;
  assert.throws(() => announcementPageIdentity({ get user() { called += 1; return {}; } }));
  assert.throws(() => announcementPageIdentity({ user: { get id() { called += 1; return 'id'; } } }));
  assert.throws(() => announcementPageIdentity({ role: { toJSON() { called += 1; return 'admin'; } } }));
  assert.equal(called, 0);
});

test('capture accepts 0, 1 and 25 exact page IDs and returns detached frozen snapshot', () => {
  for (const count of [0, 1, 25]) {
    const input = page(Array.from({ length: count }, (_, i) => row(`aa-${i.toString(16)}`)));
    const captured = captureAnnouncementPage(input, requested());
    assert.deepEqual(captured, { orgId, page: 1, pageSize: 25, total: count, ids: input.items.map(x => x.id) });
    assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.ids));
    input.items.push(row('bb-1'));
    assert.equal(captured.ids.length, count);
  }
});

test('capture bounds the current accepted page rather than total and permits valid tail/empty pages', () => {
  assert.deepEqual(captureAnnouncementPage(page([row()], 26, 2), requested(2)).ids, [recordId]);
  assert.deepEqual(captureAnnouncementPage(page([], 0, 3), requested(3)).ids, []);
  assert.equal(captureAnnouncementPage(page(Array.from({ length: 25 }, (_, i) => row(`a${i.toString(16)}`)), 1000), requested()).total, 1000);
});

test('capture rejects 26, duplicate, route-incompatible and foreign IDs before any accepted snapshot', () => {
  rejectsCapture(page(Array.from({ length: 26 }, (_, i) => row(`a${i.toString(16)}`))));
  rejectsCapture(page([row(), row()]));
  for (const id of ['', 'ABC', 'aa/bb', 'aa?bb', 5, null]) rejectsCapture(page([row(id)]));
  rejectsCapture(page([{ ...row(), orgId: 'foreign' }]));
});

test('page echo, safe pagination, total and exact item count are required', () => {
  for (const change of [
    { page: 2 }, { page: 0 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 24 }, { pageSize: '25' }, { total: -1 }, { total: 0 },
    { total: 2 }, { total: Number.MAX_SAFE_INTEGER + 1 }, { total: 1.2 },
  ]) rejectsCapture({ ...page(), ...change });
  assert.throws(() => captureAnnouncementPage(page(), { ...requested(), pageSize: 100 }));
  assert.throws(() => captureAnnouncementPage(page(), { ...requested(), orgId: '' }));
});

test('exact envelope and requested descriptors reject unknown keys/symbols/nonenumerable/accessors', () => {
  let called = 0;
  for (const input of [null, [], { ...page(), extra: 1 }, { ...page(), [Symbol('extra')]: 1 }]) rejectsCapture(input);
  const hidden = { ...page() }; Object.defineProperty(hidden, 'total', { value: 1, enumerable: false }); rejectsCapture(hidden);
  const getter = { ...page() }; Object.defineProperty(getter, 'items', { get() { called += 1; return [row()]; }, enumerable: true }); rejectsCapture(getter);
  const req = { ...requested() }; Object.defineProperty(req, 'orgId', { get() { called += 1; return orgId; }, enumerable: true });
  assert.throws(() => captureAnnouncementPage(page(), req));
  assert.throws(() => captureAnnouncementPage(page(), { ...requested(), extra: 1 }));
  assert.equal(called, 0);
});

test('all five row metadata descriptors are required and must preserve valid saved metadata', () => {
  for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) {
    const absent = row(); delete absent[key]; rejectsCapture(page([absent]));
    const hidden = row(); Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false }); rejectsCapture(page([hidden]));
  }
  for (const version of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) rejectsCapture(page([{ ...row(), version }]));
  for (const key of ['createdAt', 'updatedAt']) for (const value of ['', null, 0]) rejectsCapture(page([{ ...row(), [key]: value }]));
  assert.deepEqual(captureAnnouncementPage(page([{ ...row(), version: Number.MAX_SAFE_INTEGER, createdAt: '保存\r\n文字', updatedAt: '非日期原文' }]), requested()).ids, [recordId]);
});

test('known row getter is rejected but business and unknown getters are never read or enumerated', () => {
  let called = 0;
  const bad = row(); Object.defineProperty(bad, 'version', { enumerable: true, get() { called += 1; return 1; } }); rejectsCapture(page([bad]));
  const safe = row(); Object.defineProperty(safe, 'body', { enumerable: true, get() { called += 1; throw Error('hidden body'); } });
  Object.defineProperty(safe, Symbol('hidden'), { get() { called += 1; throw Error('hidden symbol'); } });
  const metadataOnly = new Proxy(safe, { ownKeys() { throw Error('must not enumerate row'); }, get() { throw Error('must use descriptors'); } });
  assert.deepEqual(captureAnnouncementPage(page([metadataOnly]), requested()).ids, [recordId]); assert.equal(called, 0);
});

test('dense page arrays reject sparse, accessor and custom-property data without getter execution', () => {
  rejectsCapture(page(Array(1)));
  let called = 0;
  const accessor = [row()]; Object.defineProperty(accessor, '0', { enumerable: true, get() { called += 1; return row(); } }); rejectsCapture(page(accessor));
  const extra = [row()]; extra.extra = 'unknown'; rejectsCapture(page(extra));
  const symbol = [row()]; symbol[Symbol('unknown')] = 'unknown'; rejectsCapture(page(symbol));
  assert.equal(called, 0);
});

test('snapshot confirmation returns a fresh immutable copy and validates exact metadata again', () => {
  const captured = captureAnnouncementPage(page(), requested());
  const confirmed = confirmAnnouncementPageSnapshot(captured, { orgId });
  assert.deepEqual(confirmed, captured); assert.notEqual(confirmed, captured); assert.notEqual(confirmed.ids, captured.ids);
  assert.ok(Object.isFrozen(confirmed)); assert.ok(Object.isFrozen(confirmed.ids));
  for (const change of [{ orgId: 'foreign' }, { page: 2 }, { pageSize: 100 }, { total: 0 }, { ids: [recordId, recordId] }, { ids: ['ABC'] }, { extra: true }])
    assert.throws(() => confirmAnnouncementPageSnapshot({ ...captured, ...change }, { orgId }));
  assert.throws(() => confirmAnnouncementPageSnapshot(captured, { orgId, extra: true }));
});

test('snapshot metadata and ID accessors never execute; null-prototype metadata remains valid', () => {
  const captured = captureAnnouncementPage(page(), requested()); let called = 0;
  for (const key of Object.keys(captured)) {
    const bad = { ...captured }; Object.defineProperty(bad, key, { enumerable: true, get() { called += 1; return captured[key]; } });
    assert.throws(() => confirmAnnouncementPageSnapshot(bad, { orgId }));
  }
  const badIds = [recordId]; Object.defineProperty(badIds, '0', { enumerable: true, get() { called += 1; return recordId; } });
  assert.throws(() => confirmAnnouncementPageSnapshot({ ...captured, ids: badIds }, { orgId }));
  const nullPage = Object.assign(Object.create(null), page([Object.assign(Object.create(null), row())]));
  assert.deepEqual(captureAnnouncementPage(nullPage, Object.assign(Object.create(null), requested())).ids, [recordId]);
  assert.equal(called, 0);
});

test('fresh current projection is exact, immutable, absent and independent of old page version', async () => {
  const response = state(8); const projected = await projectAnnouncementPageReadState(response, expected());
  assert.deepEqual(projected, { id: recordId, title: '合成公告', version: 8, receiptState: 'absent', readAt: null, canAcknowledge: true });
  assert.ok(Object.isFrozen(projected)); assert.ok(!Object.hasOwn(projected, 'body')); assert.ok(!Object.hasOwn(projected, 'userName'));
  response.announcement.title = 'later mutation'; assert.equal(projected.title, '合成公告');
});

test('saved receipt confirms original tuple and canonical time but preserves historical role and name', async () => {
  const response = state(8); response.receipt = receipt(8);
  const projected = await projectAnnouncementPageReadState(response, expected());
  assert.deepEqual(projected, { id: recordId, title: '合成公告', version: 8, receiptState: 'saved', readAt: time, canAcknowledge: true });
  assert.ok(!Object.hasOwn(projected, 'role')); assert.ok(!Object.hasOwn(projected, 'userName'));
});

test('new current version never inherits a prior saved receipt and tuple pollution is rejected', async () => {
  const response = state(2); response.receipt = receipt(1);
  await assert.rejects(projectAnnouncementPageReadState(response, expected()));
  for (const change of [{ id: '0'.repeat(64) }, { userId: 'foreign' }, { orgId: 'foreign' }, { announcementId: 'bb-02' }, { announcementVersion: 2 }, { role: 'unknown' }, { readAt: '2026-10-10' }]) {
    const bad = state(); bad.receipt = receipt(1, change);
    await assert.rejects(projectAnnouncementPageReadState(bad, expected()));
  }
});

test('draft, empty and non-text imported content remain separately unconfirmable without body disclosure', async () => {
  const draft = state(); draft.announcement.status = 'draft'; draft.canAcknowledge = false;
  assert.equal((await projectAnnouncementPageReadState(draft, expected())).canAcknowledge, false);
  for (const [title, text] of [[null, '保存類型：空值'], [[], '保存類型：清單'], [{ nested: 'private-token' }, '保存類型：物件'], [3, '保存類型：數字'], [false, '保存類型：布林值'], ['', '空文字']]) {
    const response = state(); response.announcement.title = title; response.announcement.body = { nested: ['private-body-token'] }; response.canAcknowledge = false;
    const projected = await projectAnnouncementPageReadState(response, expected());
    assert.equal(projected.title, text); assert.equal(projected.canAcknowledge, false);
    assert.ok(!JSON.stringify(projected).includes('private-'));
  }
});

test('malicious HTML, CRLF and a long fresh title are retained as complete literal strings', async () => {
  const response = state(); const title = `  <img src=x onerror=alert(1)>\r\n${'全文'.repeat(6000)}合成最後字  `;
  response.announcement.title = title;
  assert.equal((await projectAnnouncementPageReadState(response, expected())).title, title);
});

test('fixed response shape, fresh current consistency and eligibility cannot be bypassed', async () => {
  for (const change of [{ extra: 1 }, { currentVersion: 2 }, { currentVersion: 0 }, { canAcknowledge: false }, { receipt: undefined }])
    await assert.rejects(projectAnnouncementPageReadState({ ...state(), ...change }, expected()));
  for (const change of [{ id: 'bb-02' }, { orgId: 'foreign' }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: '' }, { body: undefined }]) {
    const response = state(); Object.assign(response.announcement, change);
    await assert.rejects(projectAnnouncementPageReadState(response, expected()));
  }
  await assert.rejects(projectAnnouncementPageReadState(state(), { ...expected(), version: 1 }));
  await assert.rejects(projectAnnouncementPageReadState(state(), { ...expected(), id: 'ABC' }));
});

test('JSON descriptor guard rejects accessors even hidden inside typed bodies without invoking them', async () => {
  let called = 0;
  for (const make of [
    response => Object.defineProperty(response, 'announcement', { enumerable: true, get() { called += 1; return state().announcement; } }),
    response => Object.defineProperty(response.announcement, 'title', { enumerable: true, get() { called += 1; return 'title'; } }),
    response => { response.announcement.body = { get nested() { called += 1; return 'hidden'; } }; },
    response => { response.announcement.body = []; Object.defineProperty(response.announcement.body, '0', { enumerable: true, get() { called += 1; return 'hidden'; } }); },
    response => Object.defineProperty(response.announcement, 'hidden', { get() { called += 1; return 'hidden'; } }),
  ]) {
    const response = state(); make(response); await assert.rejects(projectAnnouncementPageReadState(response, expected()));
  }
  const req = expected(); Object.defineProperty(req, 'userId', { enumerable: true, get() { called += 1; return userId; } });
  await assert.rejects(projectAnnouncementPageReadState(state(), req)); assert.equal(called, 0);
});

test('JSON guard rejects cycles, sparse arrays and unsupported values without coercion or serialization', async () => {
  let called = 0; const cyclic = {}; cyclic.self = cyclic;
  for (const body of [cyclic, Array(1), undefined, NaN, Infinity, 1n, Symbol('x'), () => {}, new Date(), { toJSON() { called += 1; return 'hidden'; } }]) {
    const response = state(); response.announcement.body = body; response.canAcknowledge = false;
    await assert.rejects(projectAnnouncementPageReadState(response, expected()));
  }
  const symbol = state(); symbol.announcement.body = { [Symbol('hidden')]: 'hidden' };
  await assert.rejects(projectAnnouncementPageReadState(symbol, expected())); assert.equal(called, 0);
});

test('JSON guard allows shared plain nodes and null prototypes while stripping all content from projection', async () => {
  const shared = { safe: ['imported-nested-content', 3, null, false] }; const response = state();
  response.announcement.body = Object.assign(Object.create(null), { first: shared, second: shared }); response.canAcknowledge = false;
  const projected = await projectAnnouncementPageReadState(Object.assign(Object.create(null), response), expected());
  assert.deepEqual(Object.keys(projected), ['id', 'title', 'version', 'receiptState', 'readAt', 'canAcknowledge']);
  assert.ok(!JSON.stringify(projected).includes('imported-nested-content'));
});

test('receipt confirmation uses detached JSON snapshot across asynchronous digest', async () => {
  const response = state(); response.receipt = receipt();
  const promise = projectAnnouncementPageReadState(response, expected());
  response.announcement.title = 'late title'; response.receipt.readAt = 'corrupt-late-time'; response.receipt.userName = 'late name';
  const projected = await promise;
  assert.equal(projected.title, '合成公告'); assert.equal(projected.readAt, time); assert.equal(projected.receiptState, 'saved');
});
