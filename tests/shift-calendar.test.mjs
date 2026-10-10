import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createShiftCalendarFixture, CALENDAR_BOUNDARY_DATES } from './shift-calendar-fixtures.mjs';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { calendarPeriod, calendarFilters, confirmCalendarReport, groupCalendarRows } = await import('../public/data/shift-calendar.js');
const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
const url = filters => '/api/shift-report/export?' + new URLSearchParams(filters);
const week = () => calendarPeriod('week', '2026-10-08');
const month = () => calendarPeriod('month', '2026-10-08');
async function fixture(t) { const f = await createShiftCalendarFixture(); t.after(() => f.close()); return f; }
async function full(f, role, period, status = '', requestHeaders) {
  const result = await f.request(f.clients[role], 'GET', url(calendarFilters(period, status)), undefined, requestHeaders);
  assert.equal(result.status, 200, 'Owned full calendar report request must succeed');
  assert.strictEqual(confirmCalendarReport(result.body, period, status), result.body);
  return result;
}
function completeSchemaAndPreservedEvidence(f) {
  const raw = f.rawState();
  assert.equal(Object.keys(raw.typedTables).length, 11);
  assert.equal(raw.schema.filter(value => value.type === 'trigger').length, 6);
  for (const table of ['attachment_files', 'certification_attachment_files']) {
    const contentIndex = raw.typedTables[table].columns.indexOf('content');
    assert(raw.typedTables[table].rows.some(row => row[contentIndex][0] === 'blob' && row[contentIndex][1].length > 0), 'Both immutable synthetic BLOB tables contain actual bytes');
  }
  assert(raw.tables.record_versions.some(row => row.source === 'announcement.read'), 'A real explicit reading receipt is included in the byte oracle');
  assert(raw.tables.record_versions.some(row => row.entity === 'service-records' && JSON.parse(row.snapshot).billingSnapshot), 'Approved saved pricing is included in the byte oracle');
}

test('fresh full week and month retain all rows beyond list pagination and leave the entire typed database untouched', async t => {
  const f = await fixture(t); completeSchemaAndPreservedEvidence(f);
  assert.equal(f.dataset.seededRows.length, 126);
  const before = f.captureRead();
  for (const period of [week(), month()]) for (const status of ['', 'scheduled', 'completed', 'cancelled']) {
    const response = await full(f, 'admin', period, status), filters = calendarFilters(period, status);
    same(response.body.rows, f.golden(filters), 'Complete HTTP projection equals the independent seeded-data oracle');
    assert.equal(response.body.rows.length, response.body.total);
    assert.equal(response.body.pageSize, response.body.total);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const grouped = groupCalendarRows(response.body, period, status);
    same(grouped.flatMap(value => value.rows), response.body.rows, 'Every original API row is grouped exactly once in sorted dates');
  }
  const all = await full(f, 'admin', week()); assert.equal(all.body.total, 126);
  const partial = await f.request(f.clients.admin, 'GET', '/api/shift-report?' + new URLSearchParams({ ...calendarFilters(week()), page: '1', pageSize: '100' }));
  assert.equal(partial.status, 200); assert.equal(partial.body.rows.length, 100); assert.equal(partial.body.total, 126);
  assert.throws(() => confirmCalendarReport(partial.body, week()), error => error.code === 'CALENDAR_UNCONFIRMED');
  f.assertReadUnchanged(before, 'fresh-full-calendar-and-paginated-report-rejection');
});

test('year-zero early-year leap and terminal dates use exact saved strings and reject a real malformed full report without repair', async t => {
  const f = await fixture(t), before = f.captureRead();
  for (const date of CALENDAR_BOUNDARY_DATES) for (const mode of ['week', 'month']) {
    const period = calendarPeriod(mode, date), response = await full(f, 'admin', period);
    same(response.body.rows, f.golden(calendarFilters(period)), 'Boundary dates equal persisted synthetic rows and no timezone conversion');
    assert(response.body.rows.some(row => row.date === date), 'The exact boundary saved date is present');
  }
  const empty = await full(f, 'admin', calendarPeriod('month', f.dataset.emptyAnchor));
  assert.equal(empty.body.total, 0); assert.equal(empty.body.pageSize, 0);
  assert(groupCalendarRows(empty.body, calendarPeriod('month', f.dataset.emptyAnchor)).every(group => group.rows.length === 0));
  f.assertReadUnchanged(before, 'Gregorian-boundary-and-empty-period-GETs');
  f.importShifts([f.dataset.shiftData({ date: '2026-10-08Z', status: 'cancelled', note: 'explicit malformed imported calendar date' })], { label: 'calendar-negative-date-string-complete-INSERT-only' });
  const badBefore = f.captureRead();
  const malformed = await f.request(f.clients.admin, 'GET', url(calendarFilters(week())));
  assert.equal(malformed.status, 200, 'Legacy report projection retains its original filtering behavior');
  assert.throws(() => confirmCalendarReport(malformed.body, week()), error => error.code === 'CALENDAR_UNCONFIRMED');
  f.assertReadUnchanged(badBefore, 'malformed-date-complete-response-rejected-without-repair');
});

test('every full fetch reauthorizes four roles two organizations current caregiver ownership and unchanged finance API access', async t => {
  const f = await fixture(t), before = f.captureRead();
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'caregiver2']) {
    const response = await full(f, role, week());
    same(response.body.rows, f.golden(calendarFilters(week()), role), 'Server scope equals the currently linked caregiver or full organization');
    assert(!response.body.rows.some(row => row.shiftId === f.dataset.foreignShift.id), 'Foreign rows never appear in own organization');
    for (const extra of [{ caseId: f.dataset.cases.foreign.id }, { employeeId: f.dataset.employees.foreign.id }]) {
      const denied = await f.request(f.clients[role], 'GET', url({ ...calendarFilters(week()), ...extra })); assert.equal(denied.status, 404);
    }
  }
  assert.equal((await f.request(null, 'GET', url(calendarFilters(week())))).status, 401);
  const foreign = await f.request(f.dataset.foreignClient, 'GET', url(calendarFilters(week())));
  assert.equal(foreign.status, 200); assert.equal(foreign.body.total, 1); assert.equal(foreign.body.rows[0].shiftId, f.dataset.foreignShift.id);
  for (const extra of [{ employeeId: f.dataset.employees.other.id }]) assert.equal((await f.request(f.clients.caregiver, 'GET', url({ ...calendarFilters(week()), ...extra }))).status, 404);
  f.assertReadUnchanged(before, 'four-roles-two-org-and-reference-scope-fresh-reads');
});

test('a normal assignment version change is visible only after fresh reads and excludes the former caregiver', async t => {
  const f = await fixture(t), period = month(), original = f.dataset.mutableShift;
  const initialBefore = f.captureRead();
  assert((await full(f, 'caregiver', period)).body.rows.some(row => row.shiftId === original.id));
  f.assertReadUnchanged(initialBefore, 'before-normal-assignment-change');
  const moved = await f.patch('shifts', original, { employeeId: f.dataset.employees.other.id }, f.clients.supervisor);
  assert.equal(moved.version, original.version + 1);
  const before = f.captureRead();
  assert(!(await full(f, 'caregiver', period)).body.rows.some(row => row.shiftId === original.id));
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver2']) {
    const response = await full(f, role, period), current = response.body.rows.find(row => row.shiftId === moved.id);
    assert(current, 'Current permitted actor sees freshly reassigned shift');
    assert.equal(current.version, moved.version); assert.equal(current.employeeNo, f.dataset.employees.other.employeeNo);
  }
  f.assertReadUnchanged(before, 'after-normal-assignment-change-fresh-reads'); completeSchemaAndPreservedEvidence(f);
});

test('employee inactivation and membership removal deny subsequent fresh requests while rejected GETs perform zero writes', async t => {
  const f = await fixture(t);
  await f.patch('employees', f.dataset.employees.own, { status: 'inactive' });
  let before = f.captureRead();
  const inactive = await f.request(f.clients.caregiver, 'GET', url(calendarFilters(week())));
  assert.equal(inactive.status, 403); assert.equal(inactive.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  assert.equal((await full(f, 'admin', week())).body.total, 126, 'Existing organizational report still includes the saved assignments');
  f.assertReadUnchanged(before, 'inactive-linked-employee-read-rejection');
  f.recordOwnedMutation('calendar-explicit-synthetic-membership-revocation', () => f.app.db.prepare('DELETE FROM memberships WHERE user_id=? AND org_id=?').run(f.clients.supervisor.user.id, f.orgIds.own));
  before = f.captureRead();
  const removed = await f.request(f.clients.supervisor, 'GET', url(calendarFilters(week())));
  assert.equal(removed.status, 403); assert.equal(removed.body.error.code, 'ORG_FORBIDDEN');
  f.assertReadUnchanged(before, 'revoked-membership-read-rejection'); completeSchemaAndPreservedEvidence(f);
});

test('1000 actual full rows confirm but the next row causes whole-request 413 while the old paginated report remains usable', async t => {
  const f = await fixture(t), period = calendarPeriod('week', '2027-03-18');
  const rows = Array.from({ length: 1000 }, (_, index) => f.dataset.shiftData({ date: '2027-03-18', note: 'CAL-LIMIT-' + String(index).padStart(4, '0') }));
  f.importShifts(rows, { label: 'calendar-1000-row-complete-limit-fixture' });
  let before = f.captureRead(), response = await full(f, 'admin', period);
  assert.equal(response.body.total, 1000); assert.equal(new Set(response.body.rows.map(row => row.shiftId)).size, 1000);
  f.assertReadUnchanged(before, 'exact-1000-row-full-calendar-read');
  f.importShifts([f.dataset.shiftData({ date: '2027-03-18', note: 'CAL-LIMIT-1001' })], { label: 'calendar-extra-one-row-complete-limit-fixture' });
  before = f.captureRead(); response = await f.request(f.clients.admin, 'GET', url(calendarFilters(period)));
  assert.equal(response.status, 413); assert.equal(response.body.error.code, 'REPORT_TOO_LARGE'); assert(!Object.hasOwn(response.body, 'rows'));
  const page = await f.request(f.clients.admin, 'GET', '/api/shift-report?' + new URLSearchParams({ ...calendarFilters(period), page: '11', pageSize: '100' }));
  assert.equal(page.status, 200); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1);
  f.assertReadUnchanged(before, 'whole-1001-row-rejection-and-existing-pagination');
});

test('actual UTF-8 full JSON accepts exactly two MiB and rejects one extra byte with all versions receipts pricing and BLOBs unchanged by reads', async t => {
  const f = await fixture(t), period = calendarPeriod('week', '2027-03-18');
  const item = f.importShifts([f.dataset.shiftData({ date: '2027-03-18', note: '' })], { label: 'calendar-byte-limit-initial-complete-fixture' })[0];
  const requestHeaders = { Connection: 'close' };
  const initialBefore = f.captureRead(), initial = await full(f, 'admin', period, '', requestHeaders);
  f.assertReadUnchanged(initialBefore, 'byte-limit-initial-measurement');
  const remaining = 2097152 - initial.bytes.length, chinese = Math.floor(remaining / 3), note = '字'.repeat(chinese) + 'x'.repeat(remaining % 3);
  // Explicit owned synthetic import generation; use INSERT-only new versions and
  // update only the mutable head, never an immutable trigger or existing version.
  const writeHead = (text, version, label) => f.recordOwnedMutation(label, () => {
    const time = `2026-10-09T00:00:0${version}.000Z`;
    const business = Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'orgId', 'version', 'createdAt', 'updatedAt'].includes(key)));
    const data = { ...business, note: text };
    const snapshot = { ...data, id: item.id, orgId: item.orgId, version, createdAt: item.createdAt, updatedAt: time };
    f.app.db.exec('BEGIN IMMEDIATE');
    try {
      f.app.db.prepare('UPDATE records SET data=?,version=?,updated_at=? WHERE id=?').run(JSON.stringify(data), version, time, item.id);
      f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(item.orgId, 'shifts', item.id, version, JSON.stringify(snapshot), time, 'baseline');
      f.app.db.exec('COMMIT');
    } catch (error) { f.app.db.exec('ROLLBACK'); throw error; }
  });
  writeHead(note, 2, 'calendar-exact-2MiB-owned-head-and-new-version');
  let before = f.captureRead(), exact = await full(f, 'admin', period, '', requestHeaders);
  assert.equal(exact.bytes.length, 2097152); assert.equal(Buffer.byteLength(JSON.stringify(exact.body), 'utf8'), 2097152);
  f.assertReadUnchanged(before, 'exact-2MiB-calendar-read');
  writeHead(note + 'x', 3, 'calendar-2MiB-plus-one-byte-owned-head-and-new-version');
  before = f.captureRead();
  const oversized = await f.request(f.clients.admin, 'GET', url(calendarFilters(period)), undefined, requestHeaders);
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'REPORT_TOO_LARGE'); assert(!Object.hasOwn(oversized.body, 'rows'));
  f.assertReadUnchanged(before, 'whole-byte-limit-rejection'); completeSchemaAndPreservedEvidence(f);
});
