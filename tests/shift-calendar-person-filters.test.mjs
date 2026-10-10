import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createShiftCalendarPersonFiltersFixture } from './shift-calendar-person-filters-fixtures.mjs';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { confirmCalendarLookupPage, confirmCalendarLookups, calendarPersonSelection, confirmCalendarPersonSelection } = await import('../public/data/shift-calendar-person-filters.js');
const { calendarPeriod, calendarFilters, confirmCalendarReport, groupCalendarRows } = await import('../public/data/shift-calendar.js');
const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
const week = () => calendarPeriod('week', '2026-10-08');
const person = (caseId = '', employeeId = '') => ({ caseId, employeeId });
const query = filters => '/api/shift-report/export?' + new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
async function fixture(t) {
  const f = await createShiftCalendarPersonFiltersFixture();
  assert.equal(new URL(f.base).hostname, '127.0.0.1'); assert.notEqual(new URL(f.base).port, '4310');
  t.after(() => f.close()); return f;
}
async function lists(f, role = 'admin') {
  const result = {}, rawPages = {};
  for (const entity of ['cases', 'employees']) {
    const pages = []; let total;
    for (let number = 1; number <= 100; number++) {
      const response = await f.request(f.clients[role], 'GET', `/api/${entity}?page=${number}&pageSize=100`);
      assert.equal(response.status, 200, 'Actual authorized lookup page must succeed');
      const confirmed = confirmCalendarLookupPage(response.body, entity, f.orgIds.own, number, total);
      total = confirmed.total; pages.push(response.body);
      if (number * 100 >= total) break;
    }
    result[entity] = confirmCalendarLookups(pages, entity, f.orgIds.own); rawPages[entity] = pages;
  }
  return { ...result, rawPages };
}
const projectedLists = value => ({ cases: value.cases, employees: value.employees });
async function full(f, role, p, selected = person(), status = '', confirmedLists) {
  const filters = calendarFilters(p, status, selected), response = await f.request(f.clients[role], 'GET', query(filters));
  assert.equal(response.status, 200, 'Fresh complete person-filtered export must succeed');
  assert.strictEqual(confirmCalendarReport(response.body, p, status, selected), response.body);
  if (confirmedLists) assert.strictEqual(confirmCalendarPersonSelection(response.body, selected, projectedLists(confirmedLists)), response.body);
  same(response.body.rows.map(row => row.shiftId).sort(), f.expectedShiftIds(filters, role), 'Server output matches independent full-byte saved shift IDs and foreign keys');
  assert.equal(Object.keys(response.body).length, 12); assert.equal(response.body.columns.length, 11);
  assert(response.body.rows.every(row => Object.keys(row).length === 13 && !Object.hasOwn(row, 'caseId') && !Object.hasOwn(row, 'employeeId')), 'The original row DTO is retained');
  const groups = groupCalendarRows(response.body, p, status, selected);
  same(groups.flatMap(group => group.rows), response.body.rows, 'Every original API row is grouped exactly once');
  return response;
}
function preserved(f, baseline) {
  const raw = f.rawState();
  assert.equal(f.counts().tableCount, 11); assert.equal(f.counts().triggerCount, 6);
  for (const table of ['attachment_files', 'certification_attachment_files']) same(raw.typedTables[table], baseline.typedTables[table], 'Both immutable BLOB families retain exact persisted bytes');
  for (const entity of ['service-records', 'announcement-reads']) same(raw.tables.record_versions.filter(row => row.entity === entity), baseline.tables.record_versions.filter(row => row.entity === entity), 'Approved pricing and explicit reading receipts retain complete original versions');
  assert.equal(f.counts().totalChanges, f.ledger.reduce((sum, entry) => sum + entry.changes, 0), 'Setup, logins, normal API and explicit complete synthetic fixtures are separately accounted');
}

test('actual101-plus lookup pages are complete frozen current organization choices including the26th default-list item', async t => {
  const f = await fixture(t), baseline = f.rawState(), before = f.captureRead(), result = await lists(f);
  for (const entity of ['cases', 'employees']) {
    assert(result[entity].length > 101); assert(result.rawPages[entity].length >= 2);
    assert.equal(result.rawPages[entity][0].items.length, 100); assert.equal(result[entity].length, result.rawPages[entity][0].total);
    assert(Object.isFrozen(result[entity]) && result[entity].every(Object.isFrozen)); assert(result[entity].every(item => item.orgId === f.orgIds.own));
    const first = await f.request(f.clients.admin, 'GET', `/api/${entity}`), second = await f.request(f.clients.admin, 'GET', `/api/${entity}?page=2&pageSize=25`);
    assert.equal(first.status, 200); assert.equal(first.body.pageSize, 25); assert.equal(first.body.items.length, 25); assert.equal(second.status, 200); assert(second.body.items.length > 0);
    assert(result[entity].some(item => item.id === second.body.items[0].id), 'The26th authorized choice is retained instead of treating page1 as complete');
  }
  assert(result.cases.some(item => item.id === f.personDataset.caseA.id && item.status === 'closed'));
  assert(result.employees.some(item => item.id === f.personDataset.employeeA.id && item.status === 'inactive'));
  f.assertReadUnchanged(before, '101plus-and-default25-to26-option-GETs'); preserved(f, baseline);
});

test('single double and status filters distinguish same-name master IDs using persisted shift-ID oracles', async t => {
  const f = await fixture(t), baseline = f.rawState(), before = f.captureRead(), lookups = await lists(f), data = f.personDataset;
  assert.equal(data.caseA.name, data.caseB.name); assert.equal(data.employeeA.name, data.employeeB.name);
  const results = [];
  for (const selected of [person(), person(data.caseA.id), person(data.caseB.id), person('', data.employeeA.id), person('', data.employeeB.id), person(data.caseA.id, data.employeeA.id), person(data.caseB.id, data.employeeB.id), person(data.caseB.id, data.employeeA.id)]) {
    const result = await full(f, 'admin', week(), selected, 'cancelled', lookups); results.push(result.body);
    same(result.body.filters, calendarFilters(week(), 'cancelled', selected), 'Exact selected IDs and all original filters are echoed');
  }
  assert.equal(results.at(-1).total, 0, 'An authorized incompatible pair is a confirmed empty export');
  assert.notDeepEqual(results[1].rows.map(row => row.shiftId), results[2].rows.map(row => row.shiftId), 'Equal names do not merge IDs or their distinct saved assignments');
  const a = results[5], b = results[6]; assert.equal(a.selection.case, b.selection.case); assert.equal(a.selection.employee, b.selection.employee); assert.notEqual(a.rows[0].shiftId, b.rows[0].shiftId);
  f.assertReadUnchanged(before, 'same-name-single-double-status-empty-full-reports'); preserved(f, baseline);
});

test('closed inactive absent and nontext names follow exact server fallbacks without repair or coercion', async t => {
  const f = await fixture(t), baseline = f.rawState(), before = f.captureRead(), lookups = await lists(f), data = f.personDataset;
  for (const [caseItem, employee] of [[data.caseA, data.employeeA], [data.missingCase, data.missingEmployee], [data.typedCase, data.typedEmployee]]) {
    const selected = person(caseItem.id, employee.id), selection = calendarPersonSelection(selected, projectedLists(lookups)), result = await full(f, 'admin', week(), selected, '', lookups);
    assert.equal(result.body.selection.case, selection.case); assert.equal(result.body.selection.employee, selection.employee);
    if (caseItem !== data.caseA) {
      assert.equal(selection.case, '未取得個案名稱'); assert.equal(selection.employee, '未取得服務人員名稱');
      assert.equal(result.body.rows[0].case, selection.case); assert.equal(result.body.rows[0].employee, selection.employee);
    }
  }
  const caseOption = lookups.cases.find(item => item.id === data.caseA.id), employeeOption = lookups.employees.find(item => item.id === data.employeeA.id);
  assert.equal(caseOption.name, data.caseA.name); assert(caseOption.label.includes('已結案')); assert(employeeOption.label.includes('停用'));
  assert(lookups.cases.find(item => item.id === data.typedCase.id).label.includes('狀態未確認'));
  f.assertReadUnchanged(before, 'closed-inactive-missing-nontext-current-master-GETs'); preserved(f, baseline);
});

test('all roles and both organizations use current server scope rather than a selected-period choice heuristic', async t => {
  const f = await fixture(t), baseline = f.rawState(), before = f.captureRead();
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'caregiver2']) {
    const lookups = await lists(f, role); await full(f, role, week(), person(), '', lookups);
    for (const selected of [person(f.dataset.cases.foreign.id), person('', f.dataset.employees.foreign.id), person('missing-case')]) {
      const response = await f.request(f.clients[role], 'GET', query(calendarFilters(week(), '', selected))); assert.equal(response.status, 404); assert.equal(response.body.error.code, 'NOT_FOUND');
    }
    if (role === 'caregiver') {
      same(lookups.employees.map(item => item.id), [f.dataset.employees.own.id], 'Caregiver lookup contains precisely the currently linked employee');
      assert(lookups.cases.some(item => item.id === f.personDataset.uniqueCaregiverCase.id), 'A readable case assigned only outside the chosen period remains a choice');
      const selected = person(f.personDataset.uniqueCaregiverCase.id, f.dataset.employees.own.id), empty = await full(f, role, week(), selected, '', lookups); assert.equal(empty.body.total, 0);
      assert.equal((await f.request(f.clients[role], 'GET', query(calendarFilters(week(), '', person('', f.personDataset.employeeB.id))))).status, 404);
    }
  }
  const elsewhere = await f.request(f.dataset.foreignClient, 'GET', query(calendarFilters(week(), '', person(f.dataset.cases.foreign.id, f.dataset.employees.foreign.id))));
  assert.equal(elsewhere.status, 200); same(elsewhere.body.rows.map(row => row.shiftId), [f.dataset.foreignShift.id], 'Only actual foreign-organization actor can read its own IDs');
  const unauthenticated = await f.request(null, 'GET', query(calendarFilters(week()))); assert.equal(unauthenticated.status, 401);
  for (const extra of ['caseId=a&caseId=b', 'employeeId=a&employeeId=b', 'unknown=1', 'page=1']) {
    const invalid = await f.request(f.clients.admin, 'GET', query(calendarFilters(week())) + '&' + extra); assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'INVALID_QUERY');
  }
  f.assertReadUnchanged(before, 'four-roles-two-org-current-history-based-lookup-and-query-rejection'); preserved(f, baseline);
});

test('normal reassignment removes a formerly readable unique case and stale IDs remain explicit unavailable conditions', async t => {
  const f = await fixture(t), baseline = f.rawState(), data = f.personDataset, selected = person(data.uniqueCaregiverCase.id, f.dataset.employees.own.id);
  let before = f.captureRead(), initial = await lists(f, 'caregiver');
  assert(initial.cases.some(item => item.id === selected.caseId)); await full(f, 'caregiver', calendarPeriod('week', '2028-01-10'), selected, '', initial);
  f.assertReadUnchanged(before, 'before-normal-reassignment-current-case-reference');
  const moved = await f.patch('shifts', data.mutableCaregiverShift, { employeeId: f.dataset.employees.other.id }, f.clients.supervisor); assert.equal(moved.version, data.mutableCaregiverShift.version + 1);
  before = f.captureRead(); const current = await lists(f, 'caregiver'); assert(!current.cases.some(item => item.id === selected.caseId));
  assert.throws(() => calendarPersonSelection(selected, projectedLists(current)), error => error.code === 'CALENDAR_PERSON_UNAVAILABLE' && typeof error.fields?.caseId === 'string');
  assert.equal(selected.caseId, data.uniqueCaregiverCase.id, 'The stale selected ID is retained rather than becoming all cases');
  const rejected = await f.request(f.clients.caregiver, 'GET', query(calendarFilters(week(), '', selected))); assert.equal(rejected.status, 404);
  const next = await lists(f, 'caregiver2'); assert(next.cases.some(item => item.id === selected.caseId)); await full(f, 'caregiver2', calendarPeriod('week', '2028-01-10'), person(selected.caseId, f.dataset.employees.other.id), '', next);
  f.assertReadUnchanged(before, 'fresh-reassignment-unavailable-ID-and-new-owner-zero-writes'); preserved(f, baseline);
});

test('employee inactivation and membership revocation deny subsequent lookup and export GETs with zero writes', async t => {
  const f = await fixture(t), baseline = f.rawState();
  await f.patch('employees', f.dataset.employees.own, { status: 'inactive' });
  let before = f.captureRead();
  for (const route of ['/api/cases?page=1&pageSize=100', '/api/employees?page=1&pageSize=100', query(calendarFilters(week()))]) {
    const result = await f.request(f.clients.caregiver, 'GET', route); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  }
  const lookups = await lists(f); assert(lookups.employees.some(item => item.id === f.dataset.employees.own.id && item.status === 'inactive'));
  await full(f, 'admin', week(), person('', f.dataset.employees.own.id), '', lookups); f.assertReadUnchanged(before, 'inactive-link-rejections-and-organizational-historical-options');
  f.recordOwnedMutation('person-filter-explicit-synthetic-supervisor-membership-revocation', () => f.app.db.prepare('DELETE FROM memberships WHERE user_id=? AND org_id=?').run(f.clients.supervisor.user.id, f.orgIds.own));
  before = f.captureRead();
  for (const route of ['/api/cases?page=1&pageSize=100', '/api/employees?page=1&pageSize=100', query(calendarFilters(week()))]) {
    const result = await f.request(f.clients.supervisor, 'GET', route); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ORG_FORBIDDEN');
  }
  f.assertReadUnchanged(before, 'membership-revoked-options-and-export-GETs'); preserved(f, baseline);
});

test('a true1001-row export rejects entirely and an explicit selected ID narrows it to the complete authorized result', async t => {
  const f = await fixture(t), baseline = f.rawState(), data = f.personDataset, p = calendarPeriod('month', '2027-04-15');
  f.importShifts(Array.from({ length: 1001 }, (_, index) => data.shiftData(index < 600 ? data.caseA : data.caseB, index < 600 ? data.employeeA : data.employeeB,
    { date: '2027-04-15', note: 'PF-LIMIT-' + index })), { label: 'person-filter-1001-whole-report-complete-owned-imports' });
  const before = f.captureRead(), lookups = await lists(f), rejected = await f.request(f.clients.admin, 'GET', query(calendarFilters(p)));
  assert.equal(rejected.status, 413); assert.equal(rejected.body.error.code, 'REPORT_TOO_LARGE'); assert(!Object.hasOwn(rejected.body, 'rows'));
  const selected = person(data.caseA.id, data.employeeA.id), narrowed = await full(f, 'admin', p, selected, '', lookups);
  assert.equal(narrowed.body.total, 600); assert.equal(narrowed.body.rows.length, 600); assert.equal(narrowed.body.pageSize, 600);
  const other = await full(f, 'admin', p, person(data.caseB.id), '', lookups); assert.equal(other.body.total, 401);
  f.assertReadUnchanged(before, 'whole1001-rejection-and-explicit-ID-full-narrowing'); preserved(f, baseline);
});

test('a true UTF8 oversized report preserves whole rejection and selected master IDs can recover without truncating data', async t => {
  const f = await fixture(t), baseline = f.rawState(), data = f.personDataset, p = calendarPeriod('week', '2027-05-15');
  f.importShifts([data.shiftData(data.caseA, data.employeeA, { date: '2027-05-15', note: 'PF-SMALL-LITERAL\n尾端  ' }),
    data.shiftData(data.caseB, data.employeeB, { date: '2027-05-15', note: '界'.repeat(700000) })], { label: 'person-filter-over2MiB-and-small-ID-complete-owned-imports' });
  const before = f.captureRead(), lookups = await lists(f), rejected = await f.request(f.clients.admin, 'GET', query(calendarFilters(p)));
  assert.equal(rejected.status, 413); assert.equal(rejected.body.error.code, 'REPORT_TOO_LARGE'); assert(!Object.hasOwn(rejected.body, 'rows'));
  const selected = person(data.caseA.id, data.employeeA.id), narrowed = await full(f, 'admin', p, selected, '', lookups);
  assert.equal(narrowed.body.total, 1); assert.equal(narrowed.body.rows[0].note, 'PF-SMALL-LITERAL\n尾端  ');
  const stillTooLarge = await f.request(f.clients.admin, 'GET', query(calendarFilters(p, '', person(data.caseB.id, data.employeeB.id))));
  assert.equal(stillTooLarge.status, 413); assert.equal(stillTooLarge.body.error.code, 'REPORT_TOO_LARGE');
  f.assertReadUnchanged(before, 'whole-byte-limit-rejection-and-precise-ID-recovery'); preserved(f, baseline);
});
