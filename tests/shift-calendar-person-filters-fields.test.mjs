import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { calendarPersonFilters, confirmCalendarLookupPage, confirmCalendarLookups, calendarPersonSelection, confirmCalendarPersonSelection } = await import('../public/data/shift-calendar-person-filters.js');
const { calendarPeriod, calendarFilters, confirmCalendarReport, groupCalendarRows } = await import('../public/data/shift-calendar.js');
const org = 'synthetic-person-org', limit = 2097152;
const raw = (index = 0, changes = {}) => ({ id: 'case-' + index, orgId: org, version: 1, caseNo: 'C-' + index, name: '合成個案 ' + index, status: 'active', ...changes });
const page = (items = [raw()], total = items.length, number = 1) => ({ items, total, page: number, pageSize: 100 });
const pagesFor = items => Array.from({ length: Math.max(1, Math.ceil(items.length / 100)) }, (_, index) => page(items.slice(index * 100, (index + 1) * 100), items.length, index + 1));
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const reject = (work, code = 'CALENDAR_LOOKUP_UNCONFIRMED') => assert.throws(work, error => error instanceof Error && error.code === code && !error.message.includes('SECRET'));
const unknown = '狀態未確認';
// Independent oracle states the frozen display contract literally. It never calls
// a runtime projector to construct expected fields or the byte-boundary inputs.
function projected(item, entity = 'cases') {
  const number = typeof item[entity === 'cases' ? 'caseNo' : 'employeeNo'] === 'string' ? item[entity === 'cases' ? 'caseNo' : 'employeeNo'] : '';
  const name = typeof item.name === 'string' ? item.name : '', status = typeof item.status === 'string' ? item.status : '';
  const selectionName = name || (entity === 'cases' ? '未取得個案名稱' : '未取得服務人員名稱');
  const labels = entity === 'cases' ? { active: '服務中', paused: '暫停', closed: '已結案' } : { active: '在職', inactive: '停用' };
  return { id: item.id, orgId: item.orgId, version: item.version, number, name, status, selectionName,
    label: `${number || '未填編號'} · ${selectionName}（${Object.hasOwn(labels, status) ? labels[status] : unknown}） · ${item.id}` };
}
const lookups = () => ({ cases: confirmCalendarLookups([page([raw(0), raw(1, { name: '合成個案 0' })])], 'cases', org),
  employees: confirmCalendarLookups([page([raw(0, { id: 'employee-0', employeeNo: 'E-0', name: '合成人員', status: 'inactive' })])], 'employees', org) });
const week = () => calendarPeriod('week', '2026-10-08');
const row = changes => ({ shiftId: 'synthetic-person-shift', version: 1, date: '2026-10-08', caseNo: 'C-0', case: '合成個案 0', employeeNo: 'E-0', employee: '合成人員', startTime: '09:00', endTime: '10:00', services: '合成服務 × 2', status: 'cancelled', statusLabel: '已取消', note: '保存原文字\0完整後綴', ...changes });
const columns = [['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'], ['employee', '服務人員'], ['startTime', '開始'], ['endTime', '結束'], ['services', '排班服務與數量'], ['statusLabel', '狀態'], ['version', '版次'], ['note', '交班備註']].map(([key, label]) => ({ key, label }));
function report(person = { caseId: '', employeeId: '' }, selected = { case: '全部可讀個案', employee: '全部可讀人員' }) {
  return { title: '班表明細', organization: { name: '合成機構' }, filters: { ...calendarFilters(week(), '', person) }, selection: { ...selected, status: '全部狀態' }, generatedAt: '2026-10-09T00:00:00.000Z', columns: clone(columns), rows: [row()], totals: { count: 1 }, total: 1, page: 1, pageSize: 1, note: '本機合成資料；未核定正式規則。' };
}

test('primitive exact person IDs preserve defaults literal values null prototypes and frozen inputs', () => {
  assert.deepEqual(calendarPersonFilters(), { caseId: '', employeeId: '' });
  for (const value of [{ caseId: '  ID\0尾端  ', employeeId: 'employee/<literal>' }, Object.assign(Object.create(null), { caseId: '', employeeId: 'employee-0' })]) {
    freeze(value); const result = calendarPersonFilters(value); assert.deepEqual(result, { caseId: value.caseId, employeeId: value.employeeId }); assert(Object.isFrozen(result)); assert.notStrictEqual(result, value);
  }
});

test('person conditions reject coercion unknown ownership and getters without evaluating a field', () => {
  for (const value of [null, [], new String('case'), {}, { caseId: '', employeeId: '', extra: true }, Object.create({ caseId: '', employeeId: '' }), { caseId: 0, employeeId: '' }, { caseId: '', employeeId: new String('employee') }]) reject(() => calendarPersonFilters(value), 'CALENDAR_PERSON_UNCONFIRMED');
  for (const kind of ['accessor', 'hidden', 'symbol']) {
    const value = { caseId: '', employeeId: '' }; let invoked = false;
    if (kind === 'accessor') Object.defineProperty(value, 'caseId', { enumerable: true, get() { invoked = true; throw new Error('SECRET getter'); } });
    if (kind === 'hidden') Object.defineProperty(value, 'caseId', { value: '', enumerable: false });
    if (kind === 'symbol') value[Symbol('extra')] = true;
    reject(() => calendarPersonFilters(value), 'CALENDAR_PERSON_UNCONFIRMED'); assert.equal(invoked, false);
  }
});

test('optional person arguments extend all calendar functions while original calls keep empty IDs and row references', () => {
  const p = week(), people = { caseId: 'case-0', employeeId: 'employee-0' }, selected = calendarPersonSelection(people, lookups());
  assert.deepEqual(calendarFilters(p), { startDate: p.startDate, endDate: p.endDate, caseId: '', employeeId: '', status: '' });
  assert.deepEqual(calendarFilters(p, 'cancelled', people), { startDate: p.startDate, endDate: p.endDate, ...people, status: 'cancelled' });
  const old = freeze(report()); assert.strictEqual(confirmCalendarReport(old, p), old); assert.strictEqual(groupCalendarRows(old, p).flatMap(group => group.rows)[0], old.rows[0]);
  const current = freeze(report(people, selected)); assert.strictEqual(confirmCalendarReport(current, p, '', people), current);
  assert.strictEqual(groupCalendarRows(current, p, '', people).flatMap(group => group.rows)[0], current.rows[0]);
});

test('lookup projection accepts raw extra data but returns only eight frozen display fields without trimming', () => {
  const item = raw(0, { name: ' \uFEFF<script>literal</script>\r\n🙂\0尾端 ', caseNo: ' C\n001 ', status: 'closed', extra: { notProjected: true } });
  const input = freeze(page([item])), result = confirmCalendarLookupPage(input, 'cases', org, 1);
  assert.deepEqual(result.items, [projected(item)]); assert.equal(Object.keys(result.items[0]).length, 8);
  assert(Object.isFrozen(result) && Object.isFrozen(result.items) && Object.isFrozen(result.items[0]));
  assert.equal(item.extra.notProjected, true); assert.equal(result.items[0].name, item.name);
  assert(Object.isFrozen(input) && Object.isFrozen(item));
  const nullPage = clone(input); Object.setPrototypeOf(nullPage, null); Object.setPrototypeOf(nullPage.items[0], null); assert.deepEqual(confirmCalendarLookupPage(nullPage, 'cases', org, 1).items, [projected(item)]);
});

test('missing nontext and unknown labels use exact fallbacks while empty whitespace and statuses keep server semantics', () => {
  for (const entity of ['cases', 'employees']) for (const changes of [{}, { name: '', status: null }, { name: { toString() { throw new Error('SECRET coercion'); } }, status: 3 }, { name: '  \n  ', status: 'new-imported-status' }]) {
    const item = { id: 'raw-ID', orgId: org, version: 1, ...changes };
    const result = confirmCalendarLookupPage(page([item]), entity, org, 1); assert.deepEqual(result.items[0], projected(item, entity));
  }
});

test('lookup envelopes require exact safe totals page100 sizes and mathematically complete item counts', () => {
  const changes = [value => { value.extra = true; }, value => { delete value.page; }, value => { value.pageSize = 25; }, value => { value.page = 2; }, value => { value.total = '1'; }, value => { value.total = -1; }, value => { value.total = 10001; }, value => { value.total = Number.MAX_SAFE_INTEGER + 1; }, value => { value.total = 2; }, value => { value.items = []; }];
  for (const change of changes) { const value = page(); change(value); reject(() => confirmCalendarLookupPage(value, 'cases', org, 1)); }
  for (const [entity, organization, number, total] of [['other', org, 1], ['cases', '', 1], ['cases', org, 0], ['cases', org, 101], ['cases', org, 1, 2], ['cases', org, 1, '1']]) reject(() => confirmCalendarLookupPage(page(), entity, organization, number, total));
  const empty = confirmCalendarLookups([page([], 0)], 'cases', org); assert.deepEqual(empty, []); assert(Object.isFrozen(empty)); reject(() => confirmCalendarLookupPage(page([], 0, 2), 'cases', org, 2));
});

test('dense arrays reject holes inherited items symbols hidden metadata and custom prototypes', () => {
  for (const kind of ['hole', 'symbol', 'hidden', 'extra', 'prototype', 'getter']) {
    const value = page(); let invoked = false;
    if (kind === 'hole') delete value.items[0]; if (kind === 'symbol') value.items[Symbol('extra')] = true;
    if (kind === 'hidden') Object.defineProperty(value.items, 'extra', { value: true }); if (kind === 'extra') value.items.extra = true;
    if (kind === 'prototype') Object.setPrototypeOf(value.items, class extends Array {}.prototype);
    if (kind === 'getter') Object.defineProperty(value.items, '0', { enumerable: true, get() { invoked = true; throw new Error('SECRET getter'); } });
    reject(() => confirmCalendarLookupPage(value, 'cases', org, 1)); assert.equal(invoked, false);
  }
  const inherited = Object.create(page()); reject(() => confirmCalendarLookupPage(inherited, 'cases', org, 1));
});

test('master identity is owned primitive metadata and no extra accessor or symbol is invoked', () => {
  for (const changes of [{ id: '' }, { id: 1 }, { orgId: 'foreign-org' }, { orgId: new String(org) }, { version: 0 }, { version: '1' }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }]) reject(() => confirmCalendarLookupPage(page([raw(0, changes)]), 'cases', org, 1));
  for (const key of ['id', 'name', 'unprojected']) {
    const item = raw(); let invoked = false; Object.defineProperty(item, key, { enumerable: true, get() { invoked = true; throw new Error('SECRET getter'); } });
    reject(() => confirmCalendarLookupPage(page([item]), 'cases', org, 1)); assert.equal(invoked, false);
  }
  const inherited = raw(); Object.setPrototypeOf(inherited, { other: true }); reject(() => confirmCalendarLookupPage(page([inherited]), 'cases', org, 1));
  const hidden = raw(); Object.defineProperty(hidden, 'extra', { value: true }); reject(() => confirmCalendarLookupPage(page([hidden]), 'cases', org, 1));
  const symbol = raw(); symbol[Symbol('extra')] = true; reject(() => confirmCalendarLookupPage(page([symbol]), 'cases', org, 1));
});

test('101 real options keep both pages and same-name IDs distinct in frozen complete results', () => {
  const items = Array.from({ length: 101 }, (_, index) => raw(index, { name: '同名合成個案' })), input = freeze(pagesFor(items));
  const result = confirmCalendarLookups(input, 'cases', org); assert.equal(result.length, 101); assert.deepEqual(result, items.map(item => projected(item)));
  assert.equal(new Set(result.map(item => item.id)).size, 101); assert.notEqual(result[0].label, result[1].label);
  assert(Object.isFrozen(result) && result.every(Object.isFrozen)); assert.equal(input[1].items.length, 1);
});

test('duplicate IDs within or across pages and foreign organization rows reject the whole list', () => {
  reject(() => confirmCalendarLookups([page([raw(), raw()])], 'cases', org));
  const values = Array.from({ length: 101 }, (_, index) => raw(index)); const pages = pagesFor(values); pages[1].items[0].id = pages[0].items[0].id;
  reject(() => confirmCalendarLookups(pages, 'cases', org));
  const foreign = pagesFor(Array.from({ length: 101 }, (_, index) => raw(index))); foreign[1].items[0].orgId = 'foreign'; reject(() => confirmCalendarLookups(foreign, 'cases', org));
});

test('full lookup rejects omitted extra reordered or changing-total pages and accepts the exact10000 boundary', () => {
  const input = pagesFor(Array.from({ length: 101 }, (_, index) => raw(index)));
  for (const value of [[], input.slice(0, 1), [...input, page([], 101, 3)], [...input].reverse()]) reject(() => confirmCalendarLookups(value, 'cases', org));
  const changed = clone(input); changed[1].total = 102; changed[1].items.push(raw(102)); reject(() => confirmCalendarLookups(changed, 'cases', org));
  const small = index => raw(index, { id: 'i' + index, caseNo: '', name: 'a', status: '' });
  const boundary = pagesFor(Array.from({ length: 10000 }, (_, index) => small(index))); assert.equal(confirmCalendarLookups(boundary, 'cases', org).length, 10000);
  const tooMany = pagesFor(Array.from({ length: 10001 }, (_, index) => small(index))); reject(() => confirmCalendarLookups(tooMany, 'cases', org));
});

test('the projected UTF8 list accepts exactly two MiB and rejects one more byte without counting ignored raw fields', () => {
  const item = raw(0, { name: '🙂中文\0尾端', status: '', unprojected: 'x'.repeat(limit + 1) });
  item.status = 's'.repeat(limit - Buffer.byteLength(JSON.stringify([projected(item)]), 'utf8'));
  assert.equal(Buffer.byteLength(JSON.stringify([projected(item)]), 'utf8'), limit);
  assert.deepEqual(confirmCalendarLookups([page([item])], 'cases', org), [projected(item)]);
  const over = { ...item, status: item.status + 's' }; assert.equal(Buffer.byteLength(JSON.stringify([projected(over)]), 'utf8'), limit + 1);
  reject(() => confirmCalendarLookupPage(page([over]), 'cases', org, 1)); reject(() => confirmCalendarLookups([page([over])], 'cases', org));
});

test('individually valid pages cannot bypass the aggregate two-MiB projection limit', () => {
  const values = Array.from({ length: 101 }, (_, index) => raw(index)); values[0].status = 's'.repeat(1100000); values[100].status = 's'.repeat(1100000);
  const pages = pagesFor(values); for (const [index, value] of pages.entries()) assert(confirmCalendarLookupPage(value, 'cases', org, index + 1, 101));
  assert(Buffer.byteLength(JSON.stringify(values.map(item => projected(item)))) > limit); reject(() => confirmCalendarLookups(pages, 'cases', org));
});

test('selected IDs and current master names match exactly without using a label as identity', () => {
  const lists = lookups();
  assert.deepEqual(calendarPersonSelection({ caseId: '', employeeId: '' }, lists), { case: '全部可讀個案', employee: '全部可讀人員' });
  for (const caseId of ['case-0', 'case-1']) {
    const person = { caseId, employeeId: 'employee-0' }, selected = calendarPersonSelection(person, lists), result = freeze(report(person, selected));
    assert.equal(selected.case, '合成個案 0'); assert(Object.isFrozen(selected)); assert.strictEqual(confirmCalendarPersonSelection(result, person, lists), result);
    const echo = clone(result); echo.filters.caseId = caseId === 'case-0' ? 'case-1' : 'case-0'; reject(() => confirmCalendarPersonSelection(echo, person, lists), 'CALENDAR_PERSON_UNCONFIRMED');
  }
});

test('unavailable selected IDs produce precise field errors and leave the requested primitive values unchanged', () => {
  for (const [key, person] of [['caseId', { caseId: 'missing-case', employeeId: '' }], ['employeeId', { caseId: '', employeeId: 'missing-employee' }]]) {
    const before = clone(person); freeze(person);
    assert.throws(() => calendarPersonSelection(person, lookups()), error => error.code === 'CALENDAR_PERSON_UNAVAILABLE' && typeof error.fields?.[key] === 'string');
    assert.deepEqual(person, before); assert.throws(() => confirmCalendarPersonSelection(report(person), person, lookups()), error => error.code === 'CALENDAR_PERSON_UNAVAILABLE');
  }
});

test('selection confirmation rejects mismatched names additional fields and invalid projected lookup tuples', () => {
  const person = { caseId: 'case-0', employeeId: 'employee-0' }, lists = lookups(), original = report(person, calendarPersonSelection(person, lists));
  for (const change of [r => { r.selection.case += ' '; }, r => { r.selection.employee = '同名但不是目前主檔'; }, r => { r.filters.employeeId = ''; }, r => { r.filters.extra = true; }, r => { r.selection.extra = true; }]) {
    const result = clone(original); change(result); reject(() => confirmCalendarPersonSelection(result, person, lists), 'CALENDAR_PERSON_UNCONFIRMED');
  }
  for (const change of [l => { l.cases[0].label += ' '; }, l => { l.cases[0].selectionName = 'other'; }, l => { l.employees[0].orgId = 'foreign'; }, l => { l.cases[0].extra = true; }, l => { l.cases.push(clone(l.cases[0])); }]) {
    const value = clone(lists); change(value); reject(() => calendarPersonSelection(person, value));
  }
});

test('hostile lookup reflection and non-JSON metadata are bounded errors without leaking sentinel text', () => {
  reject(() => confirmCalendarLookupPage(new Proxy(page(), { ownKeys() { throw new Error('SECRET reflection'); } }), 'cases', org, 1));
  reject(() => confirmCalendarLookups(new Proxy([page()], { ownKeys() { throw new Error('SECRET reflection'); } }), 'cases', org));
  const values = [page()]; Object.defineProperty(values, '0', { enumerable: true, get() { throw new Error('SECRET getter'); } }); reject(() => confirmCalendarLookups(values, 'cases', org));
});

test('person-aware confirmation retains original full DTO limits raw fields and precisely-once groups', () => {
  const person = { caseId: 'case-0', employeeId: 'employee-0' }, lists = lookups(), value = report(person, calendarPersonSelection(person, lists));
  freeze(value); assert.strictEqual(confirmCalendarReport(value, week(), '', person), value); assert.strictEqual(confirmCalendarPersonSelection(value, person, lists), value);
  const groups = groupCalendarRows(value, week(), '', person); assert.equal(groups.length, 7); assert.strictEqual(groups.flatMap(group => group.rows)[0], value.rows[0]); assert.equal(value.rows[0].note, '保存原文字\0完整後綴');
  for (const change of [r => { r.extra = true; }, r => { r.rows[0].caseId = 'case-0'; }, r => { r.pageSize = 25; }, r => { r.rows = Array.from({ length: 1001 }, (_, index) => row({ shiftId: 'id-' + String(index).padStart(4, '0') })); r.total = r.pageSize = r.totals.count = 1001; }, r => { r.rows[0].note = '字'.repeat(700000); }]) {
    const bad = clone(value); change(bad); reject(() => confirmCalendarReport(bad, week(), '', person), 'CALENDAR_UNCONFIRMED');
  }
  const whitespace = confirmCalendarLookups([page([raw(0, { name: ' \n ' })])], 'cases', org), selected = calendarPersonSelection({ caseId: 'case-0', employeeId: '' }, { cases: whitespace, employees: [] });
  reject(() => confirmCalendarReport(report({ caseId: 'case-0', employeeId: '' }, selected), week(), '', { caseId: 'case-0', employeeId: '' }), 'CALENDAR_UNCONFIRMED');
});
