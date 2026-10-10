import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { parseCalendarDate, calendarPeriod, calendarFilters, confirmCalendarReport, groupCalendarRows } = await import('../public/data/shift-calendar.js');
const labels = { scheduled: '已排班', completed: '已完成', cancelled: '已取消' };
const columns = [['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'], ['employee', '服務人員'], ['startTime', '開始'], ['endTime', '結束'], ['services', '排班服務與數量'], ['statusLabel', '狀態'], ['version', '版次'], ['note', '交班備註']].map(([key, label]) => ({ key, label }));
const week = () => calendarPeriod('week', '2026-10-08');
const row = (overrides = {}) => ({ shiftId: 'synthetic-shift-001', version: 1, date: '2026-10-08', caseNo: 'CASE-01', case: '合成個案', employeeNo: 'EMP-01', employee: '合成人員', startTime: '09:00', endTime: '10:00', services: '合成服務 × 2', status: 'scheduled', statusLabel: '已排班', note: '合成保存原文', ...overrides });
const report = (rows = [row()], period = week(), status = '') => ({ title: '班表明細', organization: { name: '合成班表機構' }, filters: { ...calendarFilters(period, status) }, selection: { case: '全部可讀個案', employee: '全部可讀人員', status: labels[status] || '全部狀態' }, generatedAt: '2026-10-09T00:00:00.000Z', columns: columns.map(value => ({ ...value })), rows, totals: { count: rows.length }, total: rows.length, page: 1, pageSize: rows.length, note: '本機保存班表；非正式申報。' });
const freezeDeep = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);
const fieldRejected = (work, field) => assert.throws(work, error => error instanceof Error && typeof error.fields?.[field] === 'string');
const rejected = (value, period = week(), status = '') => assert.throws(() => confirmCalendarReport(value, period, status), error => error instanceof Error && error.code === 'CALENDAR_UNCONFIRMED' && !error.message.includes('SECRET'));
const compare = (left, right) => { for (const key of ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId']) { if (left[key] < right[key]) return -1; if (left[key] > right[key]) return 1; } return 0; };

test('calendar parsing preserves four-digit years and exact endpoint ordinals in frozen values', () => {
  assert.deepEqual(parseCalendarDate('0000-01-01'), { year: 0, month: 1, day: 1, ordinal: 0 });
  assert.deepEqual(parseCalendarDate('0000-02-29'), { year: 0, month: 2, day: 29, ordinal: 59 });
  assert.deepEqual(parseCalendarDate('9999-12-31'), { year: 9999, month: 12, day: 31, ordinal: 3652424 });
  for (const date of ['0000-01-01', '0099-12-31', '2000-02-29', '9999-12-31']) assert(Object.isFrozen(parseCalendarDate(date)));
});

test('calendar dates reject coercion whitespace shortened years invalid days and ISO suffixes without normalization', () => {
  const hostile = { toString() { throw new Error('SECRET coercion must not run'); } };
  for (const value of [null, undefined, false, 0, [], {}, new String('2026-10-08'), hostile, '2026-10-08 ', ' 2026-10-08', '\n2026-10-08', '2026-10-08\n', '2026-10-08\r', '2026-10-08\r\n', '99-01-01', '0099-1-01', '10000-01-01', '-0001-01-01', '2026-10-08T00:00:00Z', '2026-00-01', '2026-13-01', '2026-01-00', '2026-04-31', '0099-02-29', '1900-02-29', '2100-02-29']) fieldRejected(() => parseCalendarDate(value), 'anchor');
});

test('an independent 400-year enumerated month table verifies every ordinal and weekday cycle', () => {
  // Independent oracle enumerates month lengths and a fixed set of 97 leap years;
  // it does not use the implementation year-prefix formula or inverse search.
  const leapYears = new Set(Array.from({ length: 100 }, (_, n) => n * 4).filter(year => ![100, 200, 300].includes(year)));
  assert.equal(leapYears.size, 97);
  let ordinal = 0, mondayColumn = 5;
  for (let year = 0; year < 400; year++) {
    const lengths = [31, leapYears.has(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month++) for (let day = 1; day <= lengths[month - 1]; day++) {
      const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      assert.equal(parseCalendarDate(text).ordinal, ordinal, 'Independent enumerated ordinal');
      if (day === 1 || day === lengths[month - 1]) {
        const p = calendarPeriod('week', text); assert.equal(p.slots[mondayColumn], text, 'Independent weekday position');
        const m = calendarPeriod('month', text); assert.equal(m.dates.length, lengths[month - 1]);
      }
      ordinal++; mondayColumn = (mondayColumn + 1) % 7;
    }
  }
  assert.equal(ordinal, 146097); assert.equal(mondayColumn, 5);
  assert.equal(parseCalendarDate('0400-01-01').ordinal, ordinal);
});

test('week periods keep Monday ordering through month year and four-digit domain boundaries', () => {
  const cases = [
    ['2026-10-08', '2026-10-05', '2026-10-11', '2026-09-28', '2026-10-12'],
    ['2026-01-01', '2025-12-29', '2026-01-04', '2025-12-22', '2026-01-05'],
    ['2000-02-29', '2000-02-28', '2000-03-05', '2000-02-21', '2000-03-06'],
  ];
  for (const [anchor, startDate, endDate, previousAnchor, nextAnchor] of cases) {
    const p = calendarPeriod('week', anchor); assert.deepEqual([p.startDate, p.endDate, p.previousAnchor, p.nextAnchor, p.rangeClipped], [startDate, endDate, previousAnchor, nextAnchor, false]);
    assert.equal(p.slots.length, 7); assert.deepEqual(p.slots, p.dates); assert.equal(new Set(p.dates).size, 7);
  }
  const first = calendarPeriod('week', '0000-01-01');
  assert.deepEqual(first.slots, [null, null, null, null, null, '0000-01-01', '0000-01-02']);
  assert.deepEqual([first.startDate, first.endDate, first.previousAnchor, first.nextAnchor, first.rangeClipped], ['0000-01-01', '0000-01-02', null, '0000-01-03', true]);
  const last = calendarPeriod('week', '9999-12-31');
  assert.deepEqual(last.slots, ['9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31', null, null]);
  assert.equal(last.nextAnchor, null); assert.equal(last.rangeClipped, true);
  assert.equal(calendarPeriod('week', first.nextAnchor).previousAnchor, '0000-01-01');
});

test('month periods always contain 42 Monday-first slots and only dates from the exact selected month', () => {
  for (const [anchor, count] of [['0000-02-29', 29], ['0099-02-28', 28], ['1900-02-28', 28], ['2000-02-29', 29], ['2100-02-28', 28], ['2026-10-08', 31], ['9999-12-31', 31]]) {
    const p = calendarPeriod('month', anchor); assert.equal(p.slots.length, 42); assert.equal(p.dates.length, count);
    assert.deepEqual(p.slots.filter(Boolean), p.dates); assert.equal(new Set(p.dates).size, count); assert(p.dates.every(date => date.startsWith(anchor.slice(0, 7) + '-')));
    assert.equal(p.rangeClipped, false); assert(Object.isFrozen(p) && Object.isFrozen(p.slots) && Object.isFrozen(p.dates));
  }
  assert.equal(calendarPeriod('month', '0000-01-01').previousAnchor, null);
  assert.equal(calendarPeriod('month', '9999-12-31').nextAnchor, null);
  assert.equal(calendarPeriod('month', '0099-12-31').nextAnchor, '0100-01-01');
  assert.equal(calendarPeriod('month', '0100-01-31').previousAnchor, '0099-12-01');
});

test('query filters reject forged ranges and invalid field types while rederiving untrusted slots', () => {
  for (const mode of ['', 'day', 'Week', null, 1, {}, new String('week')]) fieldRejected(() => calendarPeriod(mode, '2026-10-08'), 'mode');
  const p = week(), changed = { ...p, startDate: '2026-10-06' };
  fieldRejected(() => calendarFilters(changed), 'anchor'); fieldRejected(() => calendarFilters({ ...p, endDate: '2026-10-12' }), 'anchor');
  for (const status of ['active', ' scheduled', 'scheduled ', 0, null, [], new String('scheduled')]) fieldRejected(() => calendarFilters(p, status), 'status');
  const poisonedDerived = freezeDeep({ ...p, dates: ['PRIVATE-not-a-date'], slots: [], previousAnchor: 'PRIVATE', nextAnchor: 'PRIVATE' });
  for (const status of ['', 'scheduled', 'completed', 'cancelled']) assert.deepEqual(calendarFilters(poisonedDerived, status), { startDate: '2026-10-05', endDate: '2026-10-11', caseId: '', employeeId: '', status });
  assert(Object.isFrozen(calendarFilters(p)));
});

test('date-only arithmetic is identical across DST and extreme timezone environments without consulting Date', () => {
  const NativeDate = globalThis.Date;
  try {
    globalThis.Date = class { constructor() { throw new Error('Date must not be consulted'); } static parse() { throw new Error('Date parse must not be consulted'); } };
    assert.equal(parseCalendarDate('0099-12-31').year, 99);
    assert.equal(calendarPeriod('month', '0000-02-29').endDate, '0000-02-29');
    assert.equal(calendarPeriod('week', '9999-12-31').endDate, '9999-12-31');
  } finally { globalThis.Date = NativeDate; }
  const url = new URL('../public/data/shift-calendar.js', import.meta.url).href;
  const code = `globalThis.window={addEventListener(){},removeEventListener(){}};const m=await import(${JSON.stringify(url)});process.stdout.write(JSON.stringify(['0000-02-29','0099-12-31','2026-03-08','2026-11-01','9999-12-31'].map(d=>[m.parseCalendarDate(d),m.calendarPeriod('week',d),m.calendarPeriod('month',d)])));`;
  const values = ['UTC', 'America/New_York', 'Pacific/Kiritimati'].map(TZ => { const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10000 }); assert.equal(run.status, 0, 'Timezone-only isolated pure probe must complete'); return run.stdout; });
  assert.equal(values[0], values[1]); assert.equal(values[1], values[2]);
});

test('complete confirmation returns the original deeply frozen report and preserves every literal row field', () => {
  const p = week(), rows = [row({ startTime: '2026-10-08T09:00:00+14:00', endTime: '2026-10-08T10:00:00Z', case: '  合成<script>literal</script>\n🙂  ', services: '=合成 × 2\n第二行', note: '\uFEFF文字\u0000完整後綴\n尾端  ' })];
  const r = freezeDeep(report(rows, p)); assert.equal(Object.keys(r).length, 12); assert.equal(Object.keys(r.rows[0]).length, 13); assert.equal(r.columns.length, 11);
  assert.strictEqual(confirmCalendarReport(r, p), r); assert.strictEqual(r.rows[0], rows[0]); assert.equal(r.rows[0].note, '\uFEFF文字\u0000完整後綴\n尾端  ');
});

test('ordinary and null-prototype DTOs confirm without adding fields or reconstructing values', () => {
  const r = report(), p = week();
  for (const value of [r, r.organization, r.filters, r.selection, r.totals, ...r.columns, ...r.rows]) Object.setPrototypeOf(value, null);
  freezeDeep(r); assert.strictEqual(confirmCalendarReport(r, p), r);
  assert.deepEqual(groupCalendarRows(r, p).filter(group => group.rows.length).map(group => group.rows[0]), [r.rows[0]]);
});

test('exact DTO ownership rejects additional hidden symbol inherited boxed and array metadata', () => {
  const selectors = [r => r, r => r.organization, r => r.filters, r => r.selection, r => r.totals, r => r.columns[0], r => r.rows[0]];
  for (const select of selectors) {
    for (const hidden of [false, true, 'symbol']) { const r = report(), target = select(r); if (hidden === 'symbol') target[Symbol('extra')] = true; else Object.defineProperty(target, 'extra', { value: true, enumerable: !hidden }); rejected(r); }
    const inherited = report(); Object.setPrototypeOf(select(inherited), { extra: 'PRIVATE' }); rejected(inherited);
    const nonEnumerable = report(), nonEnumerableTarget = select(nonEnumerable), firstKey = Object.keys(nonEnumerableTarget)[0];
    Object.defineProperty(nonEnumerableTarget, firstKey, { value: nonEnumerableTarget[firstKey], enumerable: false }); rejected(nonEnumerable);
    let getterCalled = false; const accessor = report(), accessorTarget = select(accessor), accessorKey = Object.keys(accessorTarget)[0], saved = accessorTarget[accessorKey];
    Object.defineProperty(accessorTarget, accessorKey, { enumerable: true, get() { getterCalled = true; return saved; } }); rejected(accessor); assert.equal(getterCalled, false, 'Non-JSON accessors are rejected without invoking them');
  }
  for (const name of ['rows', 'columns']) for (const kind of ['extra', 'symbol', 'hidden', 'hole', 'subclass']) {
    const r = report(); if (kind === 'extra') r[name].extra = true; if (kind === 'symbol') r[name][Symbol('extra')] = true; if (kind === 'hidden') Object.defineProperty(r[name], 'extra', { value: true }); if (kind === 'hole') delete r[name][0]; if (kind === 'subclass') Object.setPrototypeOf(r[name], class extends Array {}.prototype); rejected(r);
  }
  const inheritedRequired = report(); const object = { ...inheritedRequired.organization }; delete inheritedRequired.organization.name; Object.setPrototypeOf(inheritedRequired.organization, object); rejected(inheritedRequired);
  const boxed = report(); boxed.organization = new String('合成'); rejected(boxed);
});

test('report identity exact filters selections columns and explanatory metadata cannot confirm another query', () => {
  const changes = [r => { r.title = '其他報表'; }, r => { r.organization.name = ''; }, r => { r.filters.endDate = '2026-10-12'; }, r => { r.filters.caseId = 'other-case'; }, r => { r.filters.employeeId = 'other-person'; }, r => { r.filters.status = 'cancelled'; }, r => { r.selection.case = '其他個案'; }, r => { r.selection.employee = '其他人員'; }, r => { r.selection.status = '已取消'; }, r => { r.columns.reverse(); }, r => { r.columns[0].label = '別名'; }, r => { r.columns[0].type = undefined; }, r => { r.generatedAt = 'not-a-timestamp'; }, r => { r.note = ' \n '; }];
  for (const change of changes) { const r = report(); change(r); rejected(r); }
  const p = week(); for (const status of Object.keys(labels)) { const r = report([row({ status, statusLabel: labels[status] })], p, status); assert.strictEqual(confirmCalendarReport(r, p, status), r); rejected(r, p, ''); }
});

test('full results reject pagination truncation and inconsistent safe counts rather than displaying partial rows', () => {
  const cases = [r => { r.total = 2; r.totals.count = 2; r.pageSize = 2; }, r => { r.rows = []; }, r => { r.page = 2; }, r => { r.pageSize = 25; }, r => { r.totals.count = 0; }, r => { r.total = '1'; }, r => { r.total = -1; }, r => { r.total = Number.MAX_SAFE_INTEGER + 1; }];
  for (const change of cases) { const r = report(); change(r); rejected(r); }
  const r = report([], week()); assert.strictEqual(confirmCalendarReport(freezeDeep(r), week()), r); assert.equal(r.pageSize, 0);
});

test('row identity versions dates primitive strings and exact known statuses reject coercion and ambiguity', () => {
  for (const changes of [{ shiftId: '' }, { version: 0 }, { version: '1' }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { date: '2026-10-04' }, { date: '2026-10-12' }, { date: '2026-10-08T00:00:00Z' }, { date: '1900-02-29' }, { note: {} }, { startTime: 900 }, { status: 'active' }, { statusLabel: '未知' }]) rejected(report([row(changes)]));
  rejected(report([row(), row()]));
  const accepted = report([row({ version: Number.MAX_SAFE_INTEGER })]); assert.strictEqual(confirmCalendarReport(accepted, week()), accepted);
  for (const [anchor, date] of [['0000-02-29', '0000-02-29'], ['0099-02-28', '0099-02-28'], ['9999-12-31', '9999-12-31']]) { const p = calendarPeriod('month', anchor), r = report([row({ date })], p); assert.strictEqual(confirmCalendarReport(r, p), r); }
});

test('row ordering uses the exact UTF-16 five-field tuple and never locale time interpretation or merging', () => {
  const rows = [row({ shiftId: 'b', caseNo: 'a' }), row({ shiftId: 'a', caseNo: 'Z' }), row({ shiftId: 'c', caseNo: 'é' }), row({ shiftId: 'd', caseNo: '中' })].sort(compare);
  const r = report(rows); assert.strictEqual(confirmCalendarReport(r, week()), r); assert.deepEqual(r.rows.map(value => value.caseNo), ['Z', 'a', 'é', '中']);
  for (const key of ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId']) {
    const pair = [row({ shiftId: 'a' }), row({ shiftId: 'b' })];
    if (key === 'date') { pair[0].date = '2026-10-07'; pair[1].date = '2026-10-08'; }
    else if (key !== 'shiftId') { pair[0][key] = 'A'; pair[1][key] = 'Z'; }
    assert.strictEqual(confirmCalendarReport(report(pair), week()).rows[0], pair[0]); rejected(report([...pair].reverse()));
  }
});

test('the full row boundary accepts all 1000 distinct rows and rejects the 1001st without truncation', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => row({ shiftId: 'id-' + String(index).padStart(4, '0') }));
  const r = freezeDeep(report(rows)); assert.strictEqual(confirmCalendarReport(r, week()), r); assert.equal(groupCalendarRows(r, week()).reduce((n, group) => n + group.rows.length, 0), 1000);
  const tooMany = report([...rows, row({ shiftId: 'id-1000' })]); rejected(tooMany); assert.equal(tooMany.rows.length, 1001);
});

test('the exact two-MiB JSON limit counts UTF-8 Chinese and supplementary characters with one-byte rejection', () => {
  const r = report([row({ note: '' })]), limit = 2097152;
  const remaining = limit - Buffer.byteLength(JSON.stringify(r), 'utf8');
  const emoji = Math.floor(remaining / 8), used = emoji * 8, chinese = Math.floor((remaining - used) / 3);
  r.rows[0].note = '🙂🙂'.repeat(emoji) + '字'.repeat(chinese) + 'x'.repeat(remaining - used - chinese * 3);
  assert.equal(Buffer.byteLength(JSON.stringify(r), 'utf8'), limit); assert.strictEqual(confirmCalendarReport(r, week()), r);
  const oversized = clone(r); oversized.rows[0].note += 'x'; assert.equal(Buffer.byteLength(JSON.stringify(oversized), 'utf8'), limit + 1); rejected(oversized);
});

test('grouping preserves every original row reference exactly once and creates frozen canonical empty-date groups', () => {
  const p = week(), rows = [row({ shiftId: 'same-time-a' }), row({ shiftId: 'same-time-b' }), row({ shiftId: 'later', date: '2026-10-10' })];
  const r = freezeDeep(report(rows, p)); const untrusted = { ...p, dates: ['PRIVATE'], slots: [] };
  const groups = groupCalendarRows(r, untrusted); assert.deepEqual(groups.map(value => value.date), p.dates); assert(Object.isFrozen(groups));
  assert(groups.every(value => Object.isFrozen(value) && Object.isFrozen(value.rows)));
  const flattened = groups.flatMap(value => value.rows); assert.equal(flattened.length, rows.length); for (let n = 0; n < rows.length; n++) assert.strictEqual(flattened[n], rows[n]);
  assert.equal(groups.filter(value => value.rows.length === 0).length, 5);
  const empty = groupCalendarRows(freezeDeep(report([], p)), p); assert.equal(empty.length, 7); assert(empty.every(value => value.rows.length === 0));
});

test('throwing getters proxies invalid periods and serialization errors produce only bounded unconfirmed errors', () => {
  const getter = report(); Object.defineProperty(getter, 'title', { enumerable: true, get() { throw new Error('SECRET getter'); } }); rejected(getter);
  rejected(new Proxy(report(), { ownKeys() { throw new Error('SECRET reflection'); } }));
  const cyclic = report(); cyclic.rows[0].note = cyclic; rejected(cyclic);
  const p = week(); rejected(report(), { ...p, endDate: 'PRIVATE' }); rejected(report(), p, 'PRIVATE');
  assert.throws(() => groupCalendarRows(report([row({ date: '2026-10-12' })]), p), error => error.code === 'CALENDAR_UNCONFIRMED');
});
