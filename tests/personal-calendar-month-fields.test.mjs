import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { PERSONAL_CALENDAR_MONTH_MAX_ITEMS, PERSONAL_CALENDAR_MONTH_MAX_BYTES,
  personalCalendarMonthPeriod, personalCalendarMonthFilters,
  confirmPersonalCalendarMonth, groupPersonalCalendarMonth } = await import('../public/data/personal-calendar-month.js');
const { formatPersonalCalendarText, formatPersonalCalendarStatus } = await import('../public/data/personal-calendar-editor.js');
const requested = (overrides = {}) => ({ month: '2026-10', q: '', status: '', orgId: 'org-synthetic', ownerUserId: 'user-synthetic', ...overrides });
const row = (index = 0, overrides = {}) => ({ id: `event-${String(index).padStart(4, '0')}`, orgId: 'org-synthetic',
  ownerUserId: 'user-synthetic', version: 1, title: `合成事件 ${index}`, date: '2026-10-01',
  startTime: '09:00', endTime: '10:00', note: ' 合成保存原文\r\n ', status: 'active', ...overrides });
const response = (items = [], overrides = {}, query = requested()) => ({ ...query, items, total: items.length, undatedCount: 0, ...overrides });
const rejected = (value, query = requested()) => assert.throws(() => confirmPersonalCalendarMonth(value, query), error =>
  error.code === 'PERSONAL_CALENDAR_MONTH_UNCONFIRMED' && error.message === '月份事件回應無法確認；請重新讀取或縮小查詢條件。');
const fieldRejected = (work, field) => assert.throws(work, error => typeof error.fields?.[field] === 'string');
const clone = value => structuredClone(value);

test('month input is an exact four-digit Gregorian month without coercion or year zero', () => {
  for (const value of [null, undefined, 202610, true, [], {}, new String('2026-10'), '2026-10 ', ' 2026-10',
    '2026-10\n', '2026-10\r', '2026-1', '26-10', '0000-01', '10000-01', '2026-00', '2026-13', '2026-10-01'])
    fieldRejected(() => personalCalendarMonthPeriod(value), 'month');
  const hostile = { toString() { assert.fail('Month coercion must not run'); } };
  fieldRejected(() => personalCalendarMonthPeriod(hostile), 'month');
});

test('known leap-year and Monday-first month oracles retain all days and six weeks', () => {
  for (const [month, days, end, firstColumn] of [
    ['0001-01', 31, '0001-01-31', 0], ['1900-02', 28, '1900-02-28', 3],
    ['2000-02', 29, '2000-02-29', 1], ['2100-02', 28, '2100-02-28', 0],
    ['2026-10', 31, '2026-10-31', 3], ['9999-12', 31, '9999-12-31', 2],
  ]) {
    const period = personalCalendarMonthPeriod(month);
    assert.equal(period.dates.length, days); assert.equal(period.slots.length, 42);
    assert.equal(period.startDate, month + '-01'); assert.equal(period.endDate, end);
    assert.equal(period.slots[firstColumn], month + '-01');
    assert.deepEqual(period.slots.filter(Boolean), period.dates);
    assert(Object.isFrozen(period) && Object.isFrozen(period.dates) && Object.isFrozen(period.slots));
  }
});

test('month navigation cannot leave years 0001 through 9999 or lose century formatting', () => {
  assert.equal(personalCalendarMonthPeriod('0001-01').previousMonth, null);
  assert.equal(personalCalendarMonthPeriod('0001-01').previousAnchor, null);
  assert.equal(personalCalendarMonthPeriod('0001-01').nextMonth, '0001-02');
  assert.equal(personalCalendarMonthPeriod('9999-12').nextMonth, null);
  assert.equal(personalCalendarMonthPeriod('9999-12').nextAnchor, null);
  assert.equal(personalCalendarMonthPeriod('9999-12').previousMonth, '9999-11');
  assert.equal(personalCalendarMonthPeriod('0099-12').nextMonth, '0100-01');
  assert.equal(personalCalendarMonthPeriod('0100-01').previousMonth, '0099-12');
});

test('literal search filters keep surrounding whitespace and enforce their own field bounds', () => {
  const q = '  Literal 查詢  ';
  assert.deepEqual(personalCalendarMonthFilters('2026-10', q, 'cancelled'), { month: '2026-10', q, status: 'cancelled' });
  assert(Object.isFrozen(personalCalendarMonthFilters('2026-10')));
  assert.equal(personalCalendarMonthFilters('2026-10', 'x'.repeat(200)).q.length, 200);
  for (const value of ['x'.repeat(201), null, 1, [], new String('q')]) fieldRejected(() => personalCalendarMonthFilters('2026-10', value), 'q');
  for (const status of ['active ', 'unknown', null, 1, {}, new String('active')]) fieldRejected(() => personalCalendarMonthFilters('2026-10', '', status), 'status');
});

test('confirmed empty month still has every empty day and keeps undated count separate', () => {
  const result = response([], { undatedCount: 7 }), confirmed = confirmPersonalCalendarMonth(result, requested());
  assert.equal(confirmed.total, 0); assert.equal(confirmed.undatedCount, 7);
  const groups = groupPersonalCalendarMonth(result, requested());
  assert.equal(groups.length, 31); assert.equal(groups[0].date, '2026-10-01'); assert.equal(groups.at(-1).date, '2026-10-31');
  assert(groups.every(group => group.rows.length === 0 && Object.isFrozen(group) && Object.isFrozen(group.rows)));
});

test('full response over 25 rows retains every event and every empty day exactly once', () => {
  const items = Array.from({ length: 61 }, (_, index) => row(index, { date: index < 30 ? '2026-10-01' : index < 60 ? '2026-10-15' : '2026-10-31' }));
  const groups = groupPersonalCalendarMonth(response(items), requested());
  assert.equal(groups.length, 31); assert.equal(groups[0].rows.length, 30); assert.equal(groups[14].rows.length, 30); assert.equal(groups[30].rows.length, 1);
  assert.equal(groups.filter(group => !group.rows.length).length, 28);
  assert.deepEqual(groups.flatMap(group => group.rows.map(item => item.id)), items.map(item => item.id));
});

test('raw own presence typed fields and CRLF remain private copied values, not guessed display text', () => {
  const first = row(0, { title: { private: 'OPAQUE_SYNTHETIC_MARKER' }, startTime: null, endTime: [1, 2], note: ' \r\n保存原文\r尾 ', status: true });
  const second = row(1, { startTime: '09:00', note: ['OPAQUE_SYNTHETIC_MARKER'] }); delete second.title; delete second.status;
  const confirmed = confirmPersonalCalendarMonth(response([first, second]), requested());
  assert.deepEqual(confirmed.items, [first, second]); assert.notEqual(confirmed.items[0], first);
  assert.equal(Object.hasOwn(confirmed.items[1], 'title'), false); assert.equal(Object.hasOwn(confirmed.items[1], 'status'), false);
  assert.equal(formatPersonalCalendarText(confirmed.items[0].title), '保存物件（內容未展示）');
  assert.equal(formatPersonalCalendarText(confirmed.items[0].note), first.note);
  assert.equal(formatPersonalCalendarText(confirmed.items[1].title, false), '未保存');
  assert.equal(formatPersonalCalendarStatus(confirmed.items[0].status), '保存布林值（內容未展示）');
  assert.equal(formatPersonalCalendarText(confirmed.items[1].note), '保存清單（內容未展示）');
});

test('duplicate ids across the reused 25-row chunk boundary cannot pass as complete', () => {
  const items = Array.from({ length: 26 }, (_, index) => row(index, { startTime: `00:${String(index).padStart(2, '0')}`, endTime: '23:59' }));
  items[25].id = items[0].id;
  rejected(response(items));
});

test('every row including rows beyond 25 must have exact org owner and safe saved identity', () => {
  const base = response(Array.from({ length: 27 }, (_, index) => row(index)));
  for (const patch of [{ orgId: 'other-org' }, { ownerUserId: 'other-user' }, { id: ' ' },
    { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: '1' }]) {
    const value = clone(base); Object.assign(value.items[26], patch); rejected(value);
  }
  for (const name of ['id', 'orgId', 'ownerUserId', 'version']) { const value = clone(base); delete value.items[26][name]; rejected(value); }
});

test('search proof is literal and confined to one own string title or note, never joined fields', () => {
  const query = requested({ q: ' aB ' });
  assert.equal(confirmPersonalCalendarMonth(response([row(0, { title: 'prefix AB suffix' })], {}, query), query).total, 1);
  rejected(response([row(0, { title: 'AB' })], {}, query), query);
  const split = requested({ q: 'alpha beta' });
  rejected(response([row(0, { title: 'alpha ', note: 'beta' })], {}, split), split);
  const typed = requested({ q: 'secret' });
  rejected(response([row(0, { title: { text: 'secret' }, note: ['secret'] })], {}, typed), typed);
  assert.equal(confirmPersonalCalendarMonth(response([row(0, { title: null, note: 'SECRET' })], {}, typed), typed).total, 1);
});

test('status and empty-query echoes are exact; malformed envelopes cannot become confirmed empty', () => {
  const active = requested({ status: 'active' });
  assert.equal(confirmPersonalCalendarMonth(response([row()], {}, active), active).total, 1);
  for (const status of ['cancelled', '', true, null]) rejected(response([row(0, { status })], {}, active), active);
  const empty = response();
  for (const patch of [{ q: ' ' }, { status: 'active' }, { month: '2026-11' }, { orgId: 'other-org' }, { ownerUserId: 'other-user' },
    { total: 1 }, { total: -1 }, { total: 0.5 }, { undatedCount: -1 }, { undatedCount: 1.5 }, { undatedCount: Number.MAX_SAFE_INTEGER + 1 },
    { items: {} }, { extra: 'SECRET_EXTRA' }]) rejected({ ...empty, ...patch });
  for (const name of Object.keys(empty)) { const value = clone(empty); delete value[name]; rejected(value); }
  const missing = requested(); delete missing.q; rejected(empty, missing);
  rejected(empty, { ...requested(), extra: '' }); rejected(empty, requested({ orgId: '' }));
});

test('only own valid saved dates in the selected month can enter the daily agenda', () => {
  for (const date of ['2026-09-30', '2026-11-01', '2026-10-00', '2026-10-32', '2026-10-01 ', '0000-10-01', null, [], 20261001])
    rejected(response([row(0, { date })]));
  const missing = row(); delete missing.date; rejected(response([missing]));
  for (const [month, date] of [['1900-02', '1900-02-29'], ['2100-02', '2100-02-29']]) {
    const query = requested({ month }); rejected(response([row(0, { date })], {}, query), query);
  }
  const leap = requested({ month: '2000-02' });
  assert.equal(confirmPersonalCalendarMonth(response([row(0, { date: '2000-02-29' })], {}, leap), leap).total, 1);
});

test('order is literal date then string start end id; non-string times have an empty key', () => {
  const items = [row(0, { startTime: 900, endTime: null }), row(1, { startTime: false, endTime: '10:00' }),
    row(2, { startTime: '09:00', endTime: '10:00' }), row(3, { startTime: '09:00', endTime: '10:00' }),
    row(4, { startTime: '9:00', endTime: '1:00' }), row(5, { date: '2026-10-02', startTime: null })];
  assert.deepEqual(confirmPersonalCalendarMonth(response(items), requested()).items, items);
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]) {
    const changed = clone(items); [changed[a], changed[b]] = [changed[b], changed[a]]; rejected(response(changed));
  }
});

test('1000 complete items are accepted and 1001 are rejected without a partial result', () => {
  assert.equal(PERSONAL_CALENDAR_MONTH_MAX_ITEMS, 1000);
  const items = Array.from({ length: 1000 }, (_, index) => row(index));
  assert.equal(confirmPersonalCalendarMonth(response(items), requested()).total, 1000);
  rejected(response([...items, row(1000)]));
  rejected(response(items.slice(0, 25), { total: 1000 }));
});

test('the full serialized envelope enforces the exact UTF-8 2MiB boundary', () => {
  assert.equal(PERSONAL_CALENDAR_MONTH_MAX_BYTES, 2097152);
  const value = response([row(0, { note: '' })]);
  const remaining = 2097152 - new TextEncoder().encode(JSON.stringify(value)).byteLength;
  value.items[0].note = 'x'.repeat(remaining);
  assert.equal(new TextEncoder().encode(JSON.stringify(value)).byteLength, 2097152);
  assert.equal(confirmPersonalCalendarMonth(value, requested()).items[0].note.length, remaining);
  const over = clone(value); over.items[0].note += 'x'; rejected(over);
  const multibyte = response([row(0, { note: '界'.repeat(Math.ceil(remaining / 3) + 1) })]);
  assert(JSON.stringify(multibyte).length < 2097152);
  assert(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength > 2097152); rejected(multibyte);
});

test('descriptor-only confirmation rejects accessors without evaluating their hidden contents', () => {
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

test('non-JSON symbols hidden descriptors unusual prototypes sparse arrays and extra array properties fail closed', () => {
  const variants = [];
  let value = response([row()]); value[Symbol('secret')] = 'SECRET_SYMBOL'; variants.push(value);
  value = response([row()]); Object.defineProperty(value.items[0], 'hidden', { value: 'SECRET_NONENUMERABLE' }); variants.push(value);
  value = response([row(0, { note: new Date('2026-10-01T00:00:00Z') })]); variants.push(value);
  value = response([row()]); Object.setPrototypeOf(value.items[0], { inherited: 'SECRET_PROTO' }); variants.push(value);
  value = response([row(0, { note: Array(2) })]); variants.push(value);
  value = response([row(0, { note: ['safe'] })]); value.items[0].note.extra = 'SECRET_EXTRA'; variants.push(value);
  value = response([row(0, { note: ['safe'] })]); Object.setPrototypeOf(value.items[0].note, null); variants.push(value);
  for (const variant of variants) rejected(variant);
});

test('cycles undefined bigint and nonfinite numbers cannot be hidden inside opaque saved fields', () => {
  for (const note of [undefined, 1n, NaN, Infinity, -Infinity, { hidden: undefined }, { hidden: 1n }, [NaN]]) rejected(response([row(0, { note })]));
  const cycle = {}; cycle.self = cycle; rejected(response([row(0, { note: cycle })]));
  const items = [row()]; items[0].note = items; rejected(response(items));
});

test('confirmation copies safe opaque JSON and own magic keys without mutation or prototype pollution', () => {
  const note = JSON.parse('{"__proto__":{"synthetic":true},"constructor":"saved","nested":[{"text":"saved"}]}');
  const value = response([row(0, { note })]);
  const confirmed = confirmPersonalCalendarMonth(value, requested());
  assert.deepEqual(confirmed, value); assert.equal(Object.hasOwn(confirmed.items[0].note, '__proto__'), true);
  assert.equal({}.synthetic, undefined); assert.notEqual(confirmed.items[0].note.nested, note.nested);
  note.nested[0].text = 'changed-after-confirmation'; value.items[0].title = 'changed-after-confirmation';
  assert.equal(confirmed.items[0].note.nested[0].text, 'saved'); assert.equal(confirmed.items[0].title, '合成事件 0');
  const nullPrototype = Object.assign(Object.create(null), { safe: '原文' });
  assert.deepEqual(confirmPersonalCalendarMonth(response([row(0, { note: nullPrototype })]), requested()).items[0].note, { safe: '原文' });
});
