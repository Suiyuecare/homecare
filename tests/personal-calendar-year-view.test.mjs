import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { PERSONAL_CALENDAR_YEAR_MAX_ITEMS, PERSONAL_CALENDAR_YEAR_MAX_BYTES,
  personalCalendarYearPeriod, personalCalendarYearFilters,
  confirmPersonalCalendarYear, groupPersonalCalendarYear } = await import('../public/data/personal-calendar-year.js');
const { formatPersonalCalendarText, formatPersonalCalendarStatus } = await import('../public/data/personal-calendar-editor.js');
const requested = (overrides = {}) => ({ year: '2026', q: '', status: '', orgId: 'org-synthetic', ownerUserId: 'user-synthetic', ...overrides });
const row = (index = 0, overrides = {}) => ({ id: `event-${String(index).padStart(4, '0')}`, orgId: 'org-synthetic',
  ownerUserId: 'user-synthetic', version: 1, title: `合成事件 ${index}`, date: '2026-01-01',
  startTime: '09:00', endTime: '10:00', note: ' 合成保存原文\r\n ', status: 'active', ...overrides });
const response = (items = [], overrides = {}, query = requested()) => ({ ...query, items, total: items.length, undatedCount: 0, ...overrides });
const rejected = (value, query = requested()) => assert.throws(() => confirmPersonalCalendarYear(value, query), error =>
  error.code === 'PERSONAL_CALENDAR_YEAR_UNCONFIRMED' && error.message === '年度事件回應無法確認；請重新讀取或縮小查詢條件。');
const fieldRejected = (work, field) => assert.throws(work, error => typeof error.fields?.[field] === 'string');
const clone = value => structuredClone(value);

test('year must be four literal digits from 0001 through 9999 without coercion', () => {
  for (const value of [null, undefined, 2026, true, [], {}, new String('2026'), '2026 ', ' 2026',
    '2026\n', '2026\r', '26', '0000', '10000', '2026-01', '+026', '２０２６'])
    fieldRejected(() => personalCalendarYearPeriod(value), 'year');
  fieldRejected(() => personalCalendarYearPeriod({ toString() { assert.fail('No coercion'); } }), 'year');
});

test('twelve full Gregorian months use known century leap oracles without missing boundary dates', () => {
  for (const [year, february, days] of [['0001', 28, 365], ['1900', 28, 365], ['2000', 29, 366], ['2100', 28, 365], ['2024', 29, 366], ['9999', 28, 365]]) {
    const period = personalCalendarYearPeriod(year);
    assert.equal(period.startDate, `${year}-01-01`); assert.equal(period.endDate, `${year}-12-31`);
    assert.equal(period.months.length, 12); assert.equal(period.months[1].dates.length, february);
    assert.equal(period.months.flatMap(month => month.dates).length, days);
    assert.deepEqual(period.months.map(month => month.month), Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`));
    assert.equal(period.months[0].dates[0], period.startDate); assert.equal(period.months[11].dates.at(-1), period.endDate);
    assert(Object.isFrozen(period) && Object.isFrozen(period.months));
    assert(period.months.every(month => Object.isFrozen(month) && Object.isFrozen(month.dates) && month.dates[0] === month.month + '-01'));
  }
});

test('previous and next years never cross 0001 or 9999 and retain leading zeroes', () => {
  assert.equal(personalCalendarYearPeriod('0001').previousYear, null);
  assert.equal(personalCalendarYearPeriod('0001').nextYear, '0002');
  assert.equal(personalCalendarYearPeriod('9999').nextYear, null);
  assert.equal(personalCalendarYearPeriod('9999').previousYear, '9998');
  assert.equal(personalCalendarYearPeriod('0099').nextYear, '0100');
  assert.equal(personalCalendarYearPeriod('0100').previousYear, '0099');
});

test('year query preserves literal whitespace and enforces independent search and status bounds', () => {
  const q = '  Literal 查詢  ';
  assert.deepEqual(personalCalendarYearFilters('2026', q, 'cancelled'), { year: '2026', q, status: 'cancelled' });
  assert(Object.isFrozen(personalCalendarYearFilters('2026')));
  assert.equal(personalCalendarYearFilters('2026', 'x'.repeat(200)).q.length, 200);
  for (const value of ['x'.repeat(201), null, 1, [], new String('q')]) fieldRejected(() => personalCalendarYearFilters('2026', value), 'q');
  for (const status of ['active ', 'unknown', null, 1, {}, new String('active')]) fieldRejected(() => personalCalendarYearFilters('2026', '', status), 'status');
});

test('an empty year still yields all twelve empty months with undated count kept separate', () => {
  const value = response([], { undatedCount: 7 }), confirmed = confirmPersonalCalendarYear(value, requested());
  assert.equal(confirmed.total, 0); assert.equal(confirmed.undatedCount, 7);
  const groups = groupPersonalCalendarYear(value, requested());
  assert.equal(groups.length, 12); assert.equal(groups[0].month, '2026-01'); assert.equal(groups.at(-1).month, '2026-12');
  assert(Object.isFrozen(groups));
  assert(groups.every(group => group.rows.length === 0 && Object.isFrozen(group) && Object.isFrozen(group.rows)));
});

test('complete cross-month response over 25 rows keeps every row exactly once in twelve groups', () => {
  const items = Array.from({ length: 72 }, (_, index) => row(index, { date: `2026-${String(Math.floor(index / 6) + 1).padStart(2, '0')}-01` }));
  const groups = groupPersonalCalendarYear(response(items), requested());
  assert.equal(groups.length, 12); assert(groups.every(group => group.rows.length === 6));
  assert.deepEqual(groups.flatMap(group => group.rows.map(item => item.id)), items.map(item => item.id));
  const sparseMonths = groupPersonalCalendarYear(response([row(0), row(1, { date: '2026-12-31' })]), requested());
  assert.equal(sparseMonths.filter(group => !group.rows.length).length, 10);
  assert.equal(sparseMonths[11].rows[0].date, '2026-12-31');
});

test('full saved typed values, own absence and CRLF remain copied and safely formatted without nested disclosure', () => {
  const first = row(0, { title: { private: 'OPAQUE_SYNTHETIC_MARKER' }, startTime: null, endTime: [1, 2], note: ' \r\n保存原文\r尾 ', status: true });
  const second = row(1, { date: '2026-12-31', note: ['OPAQUE_SYNTHETIC_MARKER'] }); delete second.title; delete second.status;
  const confirmed = confirmPersonalCalendarYear(response([first, second]), requested());
  assert.deepEqual(confirmed.items, [first, second]); assert.notEqual(confirmed.items[0], first);
  assert.equal(Object.hasOwn(confirmed.items[1], 'title'), false); assert.equal(Object.hasOwn(confirmed.items[1], 'status'), false);
  assert.equal(formatPersonalCalendarText(confirmed.items[0].title), '保存物件（內容未展示）');
  assert.equal(formatPersonalCalendarText(confirmed.items[0].note), first.note);
  assert.equal(formatPersonalCalendarText(confirmed.items[1].title, false), '未保存');
  assert.equal(formatPersonalCalendarStatus(confirmed.items[0].status), '保存布林值（內容未展示）');
  assert.equal(formatPersonalCalendarText(confirmed.items[1].note), '保存清單（內容未展示）');
});

test('unknown saved string statuses and malformed string times remain readable without invented rules', () => {
  const item = row(0, { startTime: '9時', endTime: '保存時間', status: '待另議' });
  assert.deepEqual(confirmPersonalCalendarYear(response([item]), requested()).items[0], item);
  assert.equal(formatPersonalCalendarStatus(item.status), '保存文字：待另議');
  assert.equal(formatPersonalCalendarText(item.startTime), '9時');
  rejected(response([item], {}, requested({ status: 'active' })), requested({ status: 'active' }));
});

test('duplicate ids across chunks and different months fail global completeness', () => {
  const items = Array.from({ length: 26 }, (_, index) => row(index, { date: index < 25 ? '2026-01-01' : '2026-12-31' }));
  items[25].id = items[0].id;
  rejected(response(items));
});

test('rows beyond the first chunk still require exact org and owner and positive safe versions', () => {
  const base = response(Array.from({ length: 27 }, (_, index) => row(index, { date: index < 25 ? '2026-01-01' : '2026-12-31' })));
  for (const patch of [{ orgId: 'other-org' }, { ownerUserId: 'other-user' }, { id: ' ' },
    { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: '1' }]) {
    const value = clone(base); Object.assign(value.items[26], patch); rejected(value);
  }
  for (const name of ['id', 'orgId', 'ownerUserId', 'version']) { const value = clone(base); delete value.items[26][name]; rejected(value); }
});

test('q proof keeps whitespace and matches only one own string title or note, never concatenated or nested content', () => {
  const query = requested({ q: ' aB ' });
  assert.equal(confirmPersonalCalendarYear(response([row(0, { title: 'prefix AB suffix' })], {}, query), query).total, 1);
  rejected(response([row(0, { title: 'AB' })], {}, query), query);
  const split = requested({ q: 'alpha beta' });
  rejected(response([row(0, { title: 'alpha ', note: 'beta' })], {}, split), split);
  const typed = requested({ q: 'secret' });
  rejected(response([row(0, { title: { text: 'secret' }, note: ['secret'] })], {}, typed), typed);
  assert.equal(confirmPersonalCalendarYear(response([row(0, { title: null, note: 'SECRET' })], {}, typed), typed).total, 1);
});

test('closed envelope and request require every own echo even for empty results', () => {
  const empty = response();
  for (const patch of [{ q: ' ' }, { status: 'active' }, { year: '2027' }, { orgId: 'other-org' }, { ownerUserId: 'other-user' },
    { total: 1 }, { total: -1 }, { total: 0.5 }, { undatedCount: -1 }, { undatedCount: 1.5 }, { undatedCount: Number.MAX_SAFE_INTEGER + 1 },
    { items: {} }, { extra: 'SECRET_EXTRA' }]) rejected({ ...empty, ...patch });
  for (const name of Object.keys(empty)) { const value = clone(empty); delete value[name]; rejected(value); }
  for (const name of Object.keys(requested())) { const query = requested(); delete query[name]; rejected(empty, query); }
  rejected(empty, { ...requested(), extra: '' }); rejected(empty, requested({ orgId: '' }));
});

test('selected known status is confirmed against every saved row, including the last month', () => {
  const active = requested({ status: 'active' });
  assert.equal(confirmPersonalCalendarYear(response([row(), row(1, { date: '2026-12-31' })], {}, active), active).total, 2);
  for (const status of ['cancelled', '', true, null])
    rejected(response([row(), row(1, { date: '2026-12-31', status })], {}, active), active);
});

test('agenda accepts only own valid dates in the exact selected year with real century leap days', () => {
  for (const date of ['2025-12-31', '2027-01-01', '2026-01-00', '2026-02-29', '2026-04-31', '2026-01-01 ', '0000-01-01', null, [], 20260101])
    rejected(response([row(0, { date })]));
  const missing = row(); delete missing.date; rejected(response([missing]));
  for (const year of ['1900', '2100']) {
    const query = requested({ year }); rejected(response([row(0, { date: `${year}-02-29` })], {}, query), query);
  }
  for (const [year, date] of [['2000', '2000-02-29'], ['0001', '0001-01-01'], ['9999', '9999-12-31']]) {
    const query = requested({ year }); assert.equal(confirmPersonalCalendarYear(response([row(0, { date })], {}, query), query).total, 1);
  }
});

test('global order is literal date then string start and end then id; typed times have empty sort keys', () => {
  const items = [row(0, { startTime: 900, endTime: null }), row(1, { startTime: false, endTime: '10:00' }),
    row(2, { startTime: '09:00', endTime: '10:00' }), row(3, { startTime: '09:00', endTime: '10:00' }),
    row(4, { startTime: '9:00', endTime: '1:00' }), row(5, { date: '2026-02-01', startTime: null })];
  assert.deepEqual(confirmPersonalCalendarYear(response(items), requested()).items, items);
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]) {
    const changed = clone(items); [changed[a], changed[b]] = [changed[b], changed[a]]; rejected(response(changed));
  }
});

test('1000 full rows are accepted while 1001 or claimed partial 25-of-1000 results are rejected', () => {
  assert.equal(PERSONAL_CALENDAR_YEAR_MAX_ITEMS, 1000);
  const items = Array.from({ length: 1000 }, (_, index) => row(index));
  assert.equal(confirmPersonalCalendarYear(response(items), requested()).total, 1000);
  rejected(response([...items, row(1000)]));
  rejected(response(items.slice(0, 25), { total: 1000 }));
});

test('full serialized envelope obeys the exact 2MiB UTF-8 boundary rather than a character count', () => {
  assert.equal(PERSONAL_CALENDAR_YEAR_MAX_BYTES, 2097152);
  const value = response([row(0, { note: '' })]);
  const remaining = 2097152 - new TextEncoder().encode(JSON.stringify(value)).byteLength;
  value.items[0].note = 'x'.repeat(remaining);
  assert.equal(new TextEncoder().encode(JSON.stringify(value)).byteLength, 2097152);
  assert.equal(confirmPersonalCalendarYear(value, requested()).items[0].note.length, remaining);
  const over = clone(value); over.items[0].note += 'x'; rejected(over);
  const multibyte = response([row(0, { note: '界'.repeat(Math.ceil(remaining / 3) + 1) })]);
  assert(JSON.stringify(multibyte).length < 2097152);
  assert(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength > 2097152); rejected(multibyte);
});

test('root row nested and request getters are rejected without evaluating their contents', () => {
  let getterCalls = 0;
  for (const target of ['root', 'row', 'nested', 'request']) {
    const value = response([row()]), query = requested();
    const object = target === 'root' ? value : target === 'row' ? value.items[0] : target === 'request' ? query : (value.items[0].note = {});
    const name = target === 'root' ? 'q' : target === 'request' ? 'q' : target === 'row' ? 'title' : 'hidden';
    Object.defineProperty(object, name, { enumerable: true, configurable: true, get() { getterCalls++; return 'SECRET_GETTER'; } });
    rejected(value, query);
  }
  assert.equal(getterCalls, 0);
});

test('symbols hidden descriptors class prototypes sparse arrays and extra array properties fail closed', () => {
  const variants = [];
  let value = response([row()]); value[Symbol('secret')] = 'SECRET_SYMBOL'; variants.push(value);
  value = response([row()]); Object.defineProperty(value.items[0], 'hidden', { value: 'SECRET_NONENUMERABLE' }); variants.push(value);
  value = response([row(0, { note: new Date('2026-01-01T00:00:00Z') })]); variants.push(value);
  value = response([row()]); Object.setPrototypeOf(value.items[0], { inherited: 'SECRET_PROTO' }); variants.push(value);
  value = response([row(0, { note: Array(2) })]); variants.push(value);
  value = response([row(0, { note: ['safe'] })]); value.items[0].note.extra = 'SECRET_EXTRA'; variants.push(value);
  value = response([row(0, { note: ['safe'] })]); Object.setPrototypeOf(value.items[0].note, null); variants.push(value);
  for (const variant of variants) rejected(variant);
});

test('cycles and non-JSON scalar values cannot be hidden inside saved opaque fields', () => {
  for (const note of [undefined, 1n, NaN, Infinity, -Infinity, { hidden: undefined }, { hidden: 1n }, [NaN]]) rejected(response([row(0, { note })]));
  const cycle = {}; cycle.self = cycle; rejected(response([row(0, { note: cycle })]));
  const items = [row()]; items[0].note = items; rejected(response(items));
});

test('private copies retain safe magic JSON keys and preserve all monthly groups after caller mutation', () => {
  const note = JSON.parse('{"__proto__":{"synthetic":true},"constructor":"saved","nested":[{"text":"saved"}]}');
  const value = response([row(0, { note })]);
  const confirmed = confirmPersonalCalendarYear(value, requested()), groups = groupPersonalCalendarYear(value, requested());
  assert.deepEqual(confirmed, value); assert.equal(Object.hasOwn(confirmed.items[0].note, '__proto__'), true);
  assert.equal({}.synthetic, undefined); assert.notEqual(confirmed.items[0].note.nested, note.nested);
  note.nested[0].text = 'changed-after-confirmation'; value.items[0].title = 'changed-after-confirmation';
  assert.equal(confirmed.items[0].note.nested[0].text, 'saved'); assert.equal(confirmed.items[0].title, '合成事件 0');
  assert.equal(groups[0].rows[0].note.nested[0].text, 'saved'); assert.equal(groups[0].rows[0].title, '合成事件 0');
  assert.equal(groups.slice(1).flatMap(group => group.rows).length, 0);
  const nullPrototype = Object.assign(Object.create(null), { safe: '原文' });
  assert.deepEqual(confirmPersonalCalendarYear(response([row(0, { note: nullPrototype })]), requested()).items[0].note, { safe: '原文' });
});
