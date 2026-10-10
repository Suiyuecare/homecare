import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { announcementReadId, canonicalReadTime, savedAnnouncementText, parseAnnouncementVersion,
  confirmAnnouncementReadState, confirmAnnouncementReceipt, confirmAnnouncementReadResult, confirmAnnouncementReadRoster } from '../public/data/announcement-read-receipts.js';

const time = '2026-10-09T01:02:03.456Z';
const expected = { id: '公告-合成', orgId: '機構-合成', userId: '讀者-合成' };
const makeReceipt = (overrides = {}) => {
  const receipt = { orgId: expected.orgId, announcementId: expected.id, announcementVersion: 3, userId: expected.userId, userName: '合成閱讀者', role: 'finance', readAt: time, ...overrides };
  receipt.id = createHash('sha256').update(JSON.stringify(['suiyue-announcement-read-v1', receipt.orgId, receipt.announcementId, receipt.announcementVersion, receipt.userId]), 'utf8').digest('hex');
  return receipt;
};
const makeAnnouncement = (overrides = {}) => ({ id: expected.id, orgId: expected.orgId, version: 3, createdAt: time, updatedAt: time, title: '合成公告', body: '  <script>literal</script>\n照顧交接\u0000末段  ', audience: 'all', status: 'published', ...overrides });
const state = (overrides = {}) => ({ announcement: makeAnnouncement(), currentVersion: 3, canAcknowledge: true, receipt: null, ...overrides });
const invalid = async callback => assert.rejects(callback, error => error.code === 'ANNOUNCEMENT_READ_UNCONFIRMED');

test('full WebCrypto ID uses the independent UTF8 namespace tuple and every identity component', async () => {
  const receipt = makeReceipt();
  assert.equal(await announcementReadId(receipt), receipt.id);
  assert.match(receipt.id, /^[a-f0-9]{64}$/);
  for (const overrides of [{ orgId: '另一機構' }, { announcementId: '另一公告' }, { announcementVersion: 4 }, { userId: '另一讀者' }]) assert.notEqual(await announcementReadId({ ...receipt, ...overrides }), receipt.id);
});
test('canonical saved read time rejects invalid or merely parseable dates', () => {
  assert.equal(canonicalReadTime(time), true);
  for (const value of ['2026-02-30T01:02:03.456Z', '2026-10-09T01:02:03Z', '2026-10-09T01:02:03.456+00:00', null, 0]) assert.equal(canonicalReadTime(value), false);
});
test('strict fresh state preserves original literal body and does not make a receipt', async () => {
  const value = state();
  assert.equal(await confirmAnnouncementReadState(value, expected), value);
  assert.equal(value.receipt, null);
  assert.equal(savedAnnouncementText(value.announcement.body), value.announcement.body);
  for (const value of [null, [], { ...state(), hiddenPayload: 'unsafe' }, state({ currentVersion: '3' }), state({ announcement: makeAnnouncement({ id: 'other' }) }), state({ canAcknowledge: false })]) await invalid(() => confirmAnnouncementReadState(value, expected));
});
test('typed and draft announcements remain safe to show and cannot be acknowledged', async () => {
  for (const body of [null, [], { nested: 'NEVER_RENDER' }, false, 2, '']) {
    const value = state({ announcement: makeAnnouncement({ body }), canAcknowledge: false });
    assert.equal(await confirmAnnouncementReadState(value, expected), value);
    assert.ok(!savedAnnouncementText(body).includes('NEVER_RENDER'));
    await invalid(() => confirmAnnouncementReadState({ ...value, canAcknowledge: true }, expected));
  }
  assert.equal((await confirmAnnouncementReadState(state({ announcement: makeAnnouncement({ status: 'draft' }), canAcknowledge: false }), expected)).canAcknowledge, false);
});
test('exact authorized historical/future version is not given a made-up current upper bound', async () => {
  const value = state({ announcement: makeAnnouncement({ version: 8 }), currentVersion: 3, canAcknowledge: false, receipt: makeReceipt({ announcementVersion: 8 }) });
  assert.equal(await confirmAnnouncementReadState(value, { ...expected, version: 8 }), value);
  await invalid(() => confirmAnnouncementReadState(value, expected));
});
test('own receipt accepts original empty name and historical role, never a spoofed owner or hash', async () => {
  const receipt = makeReceipt({ userName: '', role: 'caregiver' });
  assert.equal(await confirmAnnouncementReceipt(receipt, { ...expected, version: 3 }), receipt);
  for (const value of [{ ...receipt, id: receipt.id.slice(0, 32) }, { ...receipt, userId: 'other' }, { ...receipt, role: 'unknown' }, { ...receipt, readAt: 'not-time' }, { ...receipt, extra: true }]) await invalid(() => confirmAnnouncementReceipt(value, { ...expected, version: 3 }));
});
test('new POST confirmation requires exact role, version, owner, full fixed body and tuple', async () => {
  const value = { receipt: makeReceipt() }, scope = { ...expected, version: 3, role: 'finance', userName: '合成閱讀者' };
  assert.equal(await confirmAnnouncementReadResult(value, scope), value);
  for (const value of [null, [], {}, { receipt: null }, { receipt: makeReceipt({ role: 'admin' }) }, { receipt: makeReceipt({ userName: '冒用名稱' }) }, { receipt: makeReceipt({ announcementVersion: 4 }) }, { receipt: makeReceipt(), status: 'saved' }]) await invalid(() => confirmAnnouncementReadResult(value, scope));
});
test('paged roster validates complete count, unique tuples and server ordering', async () => {
  const items = [makeReceipt({ userId: 'reader-a', readAt: '2026-10-09T02:02:03.456Z' }), makeReceipt({ userId: 'reader-b' })];
  const value = { announcement: makeAnnouncement(), currentVersion: 3, items, total: 2, page: 1, pageSize: 25 }, scope = { id: expected.id, orgId: expected.orgId, page: 1, pageSize: 25 };
  assert.equal(await confirmAnnouncementReadRoster(value, scope), value);
  for (const candidate of [{ ...value, total: 3 }, { ...value, items: items.toReversed() }, { ...value, items: [items[0], items[0]] }, { ...value, page: 2 }, { ...value, pageSize: 100 }, { ...value, hidden: true }]) await invalid(() => confirmAnnouncementReadRoster(candidate, scope));
  const empty = { ...value, items: [], total: 0 };
  assert.equal(await confirmAnnouncementReadRoster(empty, scope), empty);
});
test('exact version query accepts safe integers only without a current-version maximum', () => {
  for (const value of [1, 8, Number.MAX_SAFE_INTEGER]) assert.equal(parseAnnouncementVersion(value), value);
  for (const value of [0, -1, 1.5, '01', '1', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseAnnouncementVersion(value), error => Boolean(error.fields?.version));
});
