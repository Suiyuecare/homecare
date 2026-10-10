import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createShiftCalendarPersonFiltersFixture } from './shift-calendar-person-filters-fixtures.mjs';

// Importing the shared report owner needs its window event registration, not DOM.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { calendarPeriod, calendarFilters, confirmCalendarReport } = await import('../public/data/shift-calendar.js');
const { shiftReportConfig } = await import('../public/modules/shift-report.js');
const { readCompleteReport } = await import('../public/modules/report-view.js');
const { setContext } = await import('../public/ui.js');
const nativeFetch = globalThis.fetch;
const same = (left, right, message) => assert(isDeepStrictEqual(left, right), message);
const person = (caseId = '', employeeId = '') => ({ caseId, employeeId });
const week = () => calendarPeriod('week', '2026-10-08');
const query = (path, filters) => path + '?' + new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
const aborted = error => error instanceof Error && error.name === 'AbortError';

async function fixture(t) {
  const f = await createShiftCalendarPersonFiltersFixture();
  assert.equal(new URL(f.base).hostname, '127.0.0.1');
  assert.notEqual(new URL(f.base).port, '4310');
  t.after(() => f.close());
  return f;
}

function preservedEvidence(f) {
  const raw = f.rawState();
  assert.equal(f.counts().tableCount, 11);
  assert.equal(f.counts().triggerCount, 6);
  assert.equal(Object.keys(raw.typedTables).length, 11);
  for (const table of ['attachment_files', 'certification_attachment_files']) {
    const index = raw.typedTables[table].columns.indexOf('content');
    assert(raw.typedTables[table].rows.some(row => row[index][0] === 'blob' && row[index][1].length > 0), 'Byte oracle includes both actual immutable BLOB families');
  }
  assert(raw.tables.record_versions.some(row => row.source === 'announcement.read'), 'Byte oracle includes explicit reading receipts');
  assert(raw.tables.record_versions.some(row => row.entity === 'service-records' && JSON.parse(row.snapshot).billingSnapshot), 'Byte oracle includes approved saved pricing snapshots');
  assert.equal(f.counts().totalChanges, f.ledger.reduce((sum, entry) => sum + entry.changes, 0), 'Every setup or explicit fixture mutation is separately accounted');
}

// Cookies remain memory-only. Absolute fixture requests bypass the browser-style
// relative URL adapter, so the original factory keeps owning all normal writes.
async function withReadClient(f, role, work, intercept) {
  const client = f.clients[role], previousFetch = globalThis.fetch, requests = [];
  setContext(client.auth, client.org);
  globalThis.fetch = async (path, options = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) return nativeFetch(path, options);
    assert.equal(options.method || 'GET', 'GET', 'The handoff only reads existing APIs');
    assert.equal(new URL(path, f.base).pathname, '/api/shift-report/export', 'Shared complete reader uses the full existing endpoint');
    requests.push(path);
    assert.equal(options.headers['X-Org-Id'], client.org, 'Current primitive organization is passed to fresh reads');
    if (intercept) return intercept(path, options, requests);
    return nativeFetch(f.base + path, { ...options, headers: { ...options.headers, Origin: f.base, Cookie: client.cookie } });
  };
  try { return await work(requests); }
  finally {
    globalThis.fetch = previousFetch;
    setContext({ user: null, organizations: [] });
  }
}

const strictComplete = (period, selected, status) => result => confirmCalendarReport(result, period, status, selected);
async function complete(f, role, period, selected = person(), status = '') {
  const filters = calendarFilters(period, status, selected);
  return withReadClient(f, role, async requests => {
    const result = await readCompleteReport(shiftReportConfig, filters, {
      signal: new AbortController().signal, isCurrent: () => true,
      confirmComplete: strictComplete(period, selected, status),
    });
    assert.equal(requests.length, 1, 'Each read performs one fresh full HTTP fetch');
    same(Object.fromEntries(new URL(requests[0], f.base).searchParams), Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')), 'The exact primitive filter strings reach the server without form conversion');
    same(result.filters, filters, 'All five original filters are echoed exactly');
    same(result.rows.map(row => row.shiftId).sort(), f.expectedShiftIds(filters, role), 'Rows equal an independent oracle of persisted IDs and foreign keys, never visible names');
    assert.equal(result.rows.length, result.total);
    assert.equal(result.columns.length, 11);
    assert(result.rows.every(row => Object.keys(row).length === 13 && !Object.hasOwn(row, 'caseId') && !Object.hasOwn(row, 'employeeId')), 'The existing row DTO is preserved');
    return result;
  });
}

// Independently parse quoted CSV fields, including embedded line breaks, commas,
// and doubled quotes. This never imports the server's encoder or a report mapper.
function parseCsv(bytes) {
  const source = bytes.toString('utf8');
  assert.equal(source.charCodeAt(0), 0xfeff, 'The original UTF-8 BOM is retained');
  const rows = []; let offset = 1;
  while (offset < source.length) {
    const row = [];
    for (;;) {
      assert.equal(source[offset++], '"', 'The original CSV uses quoted fields');
      let field = '', closed = false;
      while (offset < source.length) {
        const value = source[offset++];
        if (value !== '"') { field += value; continue; }
        if (source[offset] === '"') { field += '"'; offset++; continue; }
        closed = true; break;
      }
      assert(closed, 'Every CSV field closes without truncation');
      row.push(field);
      if (source[offset] === ',') { offset++; continue; }
      assert.equal(source.slice(offset, offset + 2), '\r\n', 'Every CSV row ends in original CRLF');
      offset += 2; break;
    }
    rows.push(row);
  }
  return rows;
}

async function csv(f, role, report) {
  const result = await f.request(f.clients[role], 'GET', query('/api/shift-report.csv', report.filters));
  assert.equal(result.status, 200);
  assert(result.headers.get('content-type')?.startsWith('text/csv;'));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const rows = parseCsv(result.bytes);
  same(rows[0], report.columns.map(column => column.label), 'The complete CSV retains all eleven original headings');
  same(rows.slice(1, -1), report.rows.map(row => report.columns.map(column => String(row[column.key]))), 'Every complete CSV cell equals the independently ID-confirmed current report, including literal multiline content');
  same(rows.at(-1), [report.note], 'The original complete-report notice is retained');
  assert.equal(rows.length, report.total + 2);
  return result;
}

test('shared handoff reads fresh complete week and month then original CSV with all typed state unchanged', async t => {
  const f = await fixture(t); preservedEvidence(f);
  const before = f.captureRead();
  for (const period of [week(), calendarPeriod('month', '2026-10-08')]) {
    const report = await complete(f, 'admin', period);
    assert(report.total > 100, 'Complete output includes saved rows beyond the old list page');
    await csv(f, 'admin', report);
  }
  f.assertReadUnchanged(before, 'handoff-week-month-shared-reader-and-complete-CSV');
  preservedEvidence(f);
});

test('same-name exact-ID handoffs retain single and paired filters across fresh JSON and full CSV', async t => {
  const f = await fixture(t), data = f.personDataset, before = f.captureRead();
  assert.equal(data.caseA.name, data.caseB.name);
  assert.equal(data.employeeA.name, data.employeeB.name);
  const reports = [];
  for (const selected of [person(data.caseA.id), person(data.caseB.id), person('', data.employeeA.id), person('', data.employeeB.id), person(data.caseA.id, data.employeeA.id), person(data.caseB.id, data.employeeB.id)]) {
    const report = await complete(f, 'admin', week(), selected, 'cancelled');
    reports.push(report); await csv(f, 'admin', report);
  }
  assert.notDeepEqual(reports[0].rows.map(row => row.shiftId), reports[1].rows.map(row => row.shiftId), 'Equal display names cannot merge saved assignments');
  assert.equal(reports[4].selection.case, reports[5].selection.case);
  assert.equal(reports[4].selection.employee, reports[5].selection.employee);
  assert.notEqual(reports[4].rows[0].shiftId, reports[5].rows[0].shiftId);
  assert.notEqual(reports[4].rows[0].caseNo, reports[5].rows[0].caseNo);
  f.assertReadUnchanged(before, 'handoff-six-literal-ID-filter-and-CSV-pairs');
});

test('fresh handoff carries year zero leap and terminal dates without native date input normalization', async t => {
  const f = await fixture(t), before = f.captureRead();
  for (const anchor of ['0000-01-01', '0000-02-29', '9999-12-31']) for (const mode of ['week', 'month']) {
    const period = calendarPeriod(mode, anchor), report = await complete(f, 'admin', period);
    assert(report.rows.some(row => row.date === anchor), 'The exact saved four-digit boundary date remains present');
    assert.equal(report.filters.startDate, period.startDate);
    assert.equal(report.filters.endDate, period.endDate);
    await csv(f, 'admin', report);
  }
  f.assertReadUnchanged(before, 'handoff-six-boundary-periods-and-literal-CSV-dates');
});

test('same selected IDs show fresh master renames and normal new shift versions without pinning old names', async t => {
  const f = await fixture(t), data = f.personDataset;
  const selected = person(data.caseA.id, data.employeeA.id), filters = calendarFilters(week(), 'cancelled', selected);
  const initialBefore = f.captureRead(), initial = await complete(f, 'supervisor', week(), selected, 'cancelled');
  f.assertReadUnchanged(initialBefore, 'handoff-before-normal-master-renames');
  const renamedCase = await f.patch('cases', data.caseA, { name: '合成更新個案 "完整,原文"\n🙂  ' });
  const renamedEmployee = await f.patch('employees', data.employeeA, { name: '合成更新人員 <img>literal</img>\n尾端  ' });
  assert.equal(renamedCase.id, selected.caseId); assert.equal(renamedCase.version, data.caseA.version + 1);
  assert.equal(renamedEmployee.id, selected.employeeId); assert.equal(renamedEmployee.version, data.employeeA.version + 1);
  let before = f.captureRead();
  const current = await complete(f, 'supervisor', week(), selected, 'cancelled');
  same(current.filters, filters, 'Fresh names never replace the captured primitive IDs');
  assert.equal(current.selection.case, renamedCase.name);
  assert.equal(current.selection.employee, renamedEmployee.name);
  assert.notEqual(current.selection.case, initial.selection.case);
  assert.equal(current.rows[0].case, renamedCase.name); assert.equal(current.rows[0].employee, renamedEmployee.name);
  await csv(f, 'supervisor', current);
  f.assertReadUnchanged(before, 'handoff-fresh-current-master-names-and-CSV');
  const original = f.dataset.mutableShift;
  const changed = await f.patch('shifts', original, { note: '合成新版交班 "逗號,與引號"\n完整第二行🙂  ' }, f.clients.supervisor);
  assert.equal(changed.version, original.version + 1);
  before = f.captureRead();
  const updated = await complete(f, 'supervisor', calendarPeriod('month', '2026-10-08'), person(original.caseId, original.employeeId));
  const row = updated.rows.find(value => value.shiftId === original.id);
  assert.equal(row.version, changed.version); assert.equal(row.note, changed.note);
  await csv(f, 'supervisor', updated);
  f.assertReadUnchanged(before, 'handoff-fresh-normal-shift-version-and-full-CSV');
  preservedEvidence(f);
});

test('fresh JSON and CSV retain existing role scope linked caregivers foreign-ID denial and finance API access', async t => {
  const f = await fixture(t), before = f.captureRead();
  for (const role of ['admin', 'supervisor', 'caregiver', 'caregiver2', 'finance']) {
    const selected = role === 'caregiver' ? person('', f.dataset.employees.own.id) : role === 'caregiver2' ? person('', f.dataset.employees.other.id) : person();
    const report = await complete(f, role, week(), selected);
    await csv(f, role, report);
    assert(!report.rows.some(row => row.shiftId === f.dataset.foreignShift.id));
    for (const excluded of [person(f.dataset.cases.foreign.id), person('', f.dataset.employees.foreign.id)]) {
      const filters = calendarFilters(week(), '', excluded);
      for (const path of ['/api/shift-report/export', '/api/shift-report.csv']) {
        const response = await f.request(f.clients[role], 'GET', query(path, filters));
        assert.equal(response.status, 404); assert.equal(response.body.error.code, 'NOT_FOUND');
      }
    }
  }
  for (const path of ['/api/shift-report/export', '/api/shift-report.csv']) {
    const foreignEmployee = await f.request(f.clients.caregiver, 'GET', query(path, calendarFilters(week(), '', person('', f.personDataset.employeeB.id))));
    assert.equal(foreignEmployee.status, 404);
    const unauthenticated = await f.request(null, 'GET', query(path, calendarFilters(week())));
    assert.equal(unauthenticated.status, 401);
  }
  f.assertReadUnchanged(before, 'handoff-five-existing-server-roles-and-all-denied-GETs');
  preservedEvidence(f);
});

test('shared complete reader rejects pre-aborted and stale callers before or after fresh confirmation', async t => {
  const f = await fixture(t), before = f.captureRead(), filters = calendarFilters(week());
  await withReadClient(f, 'admin', async requests => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, { signal: controller.signal, isCurrent: () => true }), aborted);
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, { signal: new AbortController().signal, isCurrent: () => false }), aborted);
    assert.equal(requests.length, 0, 'Already stale or cancelled work initiates no HTTP request');
    let current = true, confirmations = 0;
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, {
      signal: new AbortController().signal, isCurrent: () => current,
      confirmComplete(result) { confirmations++; confirmCalendarReport(result, week()); current = false; },
    }), aborted);
    assert.equal(requests.length, 1);
    assert.equal(confirmations, 1, 'Losing the caller during confirmation cannot release a DTO');
  });
  f.assertReadUnchanged(before, 'handoff-pre-abort-stale-and-post-confirmation-caller-loss');
});

test('a confirmed empty export is rejected by the shared output reader without making successful printable content', async t => {
  const f = await fixture(t), period = calendarPeriod('month', '2027-03-18'), filters = calendarFilters(period), before = f.captureRead();
  await withReadClient(f, 'admin', async requests => {
    let confirmations = 0;
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, {
      signal: new AbortController().signal, isCurrent: () => true,
      confirmComplete(result) { confirmations++; assert.equal(result.total, 0); confirmCalendarReport(result, period); },
    }), error => error instanceof Error && error.message === shiftReportConfig.copy.emptyExport);
    assert.equal(requests.length, 1); assert.equal(confirmations, 1);
  });
  f.assertReadUnchanged(before, 'handoff-confirmed-empty-output-rejection');
});

test('opt-in calendar confirmation rejects forged full DTOs while returning the exact original valid DTO', async t => {
  const f = await fixture(t), before = f.captureRead(), filters = calendarFilters(week());
  const real = await f.request(f.clients.admin, 'GET', query('/api/shift-report/export', filters));
  assert.equal(real.status, 200); const valid = real.body;
  const variants = [
    value => { value.unexpected = 'synthetic'; },
    value => { value.organization.unexpected = true; },
    value => { value.columns[0].unexpected = true; },
    value => { value.rows.reverse(); },
    value => { value.filters.employeeId = f.personDataset.employeeA.id; },
    value => { value.rows[0].note = '界'.repeat(700000); },
  ];
  for (const poison of variants) {
    const altered = structuredClone(valid); poison(altered);
    await withReadClient(f, 'admin', async () => {
      await assert.rejects(readCompleteReport(shiftReportConfig, filters, {
        signal: new AbortController().signal, isCurrent: () => true, confirmComplete: strictComplete(week(), person(), ''),
      }), error => error instanceof Error);
    }, () => ({ ok: true, status: 200, async json() { return altered; } }));
  }
  await withReadClient(f, 'admin', async () => {
    const result = await readCompleteReport(shiftReportConfig, filters, {
      signal: new AbortController().signal, isCurrent: () => true,
      confirmComplete(value) { assert.strictEqual(value, valid); confirmCalendarReport(value, week()); return { syntheticWrongReplacement: true }; },
    });
    assert.strictEqual(result, valid, 'The shared adapter ignores validator replacement values and retains the original DTO');
  }, () => ({ ok: true, status: 200, async json() { return valid; } }));
  f.assertReadUnchanged(before, 'handoff-exact-envelope-sort-filter-byte-and-original-DTO-guards');
});

test('actual whole-report 413 rejects JSON and CSV then explicit IDs recover the complete authorized result', async t => {
  const f = await fixture(t), data = f.personDataset, period = calendarPeriod('month', '2027-04-15');
  f.importShifts(Array.from({ length: 1001 }, (_, index) => data.shiftData(index < 600 ? data.caseA : data.caseB, index < 600 ? data.employeeA : data.employeeB, { date: '2027-04-15', note: 'HANDOFF-LIMIT-' + index })), { label: 'handoff-1001-complete-owned-shift-imports' });
  const before = f.captureRead(), filters = calendarFilters(period);
  await withReadClient(f, 'admin', async () => {
    let confirmations = 0;
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, {
      signal: new AbortController().signal, isCurrent: () => true, confirmComplete() { confirmations++; },
    }), error => error.status === 413 && error.code === 'REPORT_TOO_LARGE');
    assert.equal(confirmations, 0, 'Rejected HTTP does not masquerade as a confirmed DTO');
  });
  const rejectedCsv = await f.request(f.clients.admin, 'GET', query('/api/shift-report.csv', filters));
  assert.equal(rejectedCsv.status, 413); assert.equal(rejectedCsv.body.error.code, 'REPORT_TOO_LARGE');
  assert(!Object.hasOwn(rejectedCsv.body, 'rows'));
  const selected = person(data.caseA.id, data.employeeA.id), recovered = await complete(f, 'admin', period, selected);
  assert.equal(recovered.total, 600); assert.equal(recovered.rows.length, 600); await csv(f, 'admin', recovered);
  f.assertReadUnchanged(before, 'handoff-full-413-and-explicit-ID-complete-recovery');
  preservedEvidence(f);
});

test('a real malformed imported saved date is rejected by the calendar output validator without repair', async t => {
  const f = await fixture(t), data = f.personDataset, selected = person(data.caseA.id, data.employeeA.id);
  f.importShifts([data.shiftData(data.caseA, data.employeeA, { date: '2026-10-08Z', note: 'HANDOFF explicit malformed literal imported date' })], { label: 'handoff-negative-date-complete-owned-shift-import' });
  const before = f.captureRead(), filters = calendarFilters(week(), '', selected);
  const original = await f.request(f.clients.admin, 'GET', query('/api/shift-report/export', filters));
  assert.equal(original.status, 200, 'The unchanged legacy API keeps its existing literal filter behavior');
  assert(original.body.rows.some(row => row.date === '2026-10-08Z'));
  await assert.rejects(complete(f, 'admin', week(), selected), error => error instanceof Error);
  f.assertReadUnchanged(before, 'handoff-real-malformed-calendar-result-fails-without-repair');
});

test('shared transport failures never return content and a fresh retry performs another complete GET', async t => {
  const f = await fixture(t), filters = calendarFilters(week()), before = f.captureRead();
  const options = { signal: new AbortController().signal, isCurrent: () => true, confirmComplete: strictComplete(week(), person(), '') };
  await withReadClient(f, 'admin', async requests => {
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, options), error => error.status === 503 && error.code === 'SYNTHETIC_UNAVAILABLE');
    assert.equal(requests.length, 1);
  }, () => new Response(JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成暫時無法讀取' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  await withReadClient(f, 'admin', async requests => {
    await assert.rejects(readCompleteReport(shiftReportConfig, filters, options), error => error instanceof Error && error.message.includes('無法讀取伺服器回應'));
    assert.equal(requests.length, 1);
  }, () => new Response('synthetic malformed JSON', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const recovered = await complete(f, 'admin', week()); assert(recovered.total > 0);
  f.assertReadUnchanged(before, 'handoff-503-invalid-JSON-and-fresh-full-read-retry');
});
