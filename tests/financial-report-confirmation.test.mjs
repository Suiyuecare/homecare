import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmFinancialReport } from '../public/data/financial-report-confirmation.js';

const month = '2026-10';
const note = '試算、未核定規則。僅計入已核閱服務，以核閱時保存的價格及時薪快照計算；未處理補助、自付額、加班、稅費或正式薪資/核銷規則，不可作正式申報。示範資料與價格均為合成測試值。';
const columns = {
  fees: [['date', '日期'], ['case', '個案'], ['serviceCode', '測試服務代碼'], ['service', '服務項目'], ['quantity', '數量'], ['unitPriceCents', '單價（分）'], ['amountCents', '試算金額（分）']],
  payroll: [['employeeNo', '員工編號'], ['employee', '員工'], ['minutes', '核閱服務分鐘'], ['hourlyRateCents', '時薪（分）'], ['amountCents', '試算金額（分）']],
};
const fee = (changes = {}) => ({ date: '2026-10-08', case: '合成個案', serviceCode: 'SYNTHETIC-SERVICE', service: '合成保存服務', quantity: 2, unitPriceCents: 10000, amountCents: 20000, ...changes });
const payroll = (changes = {}) => ({ employeeNo: 'SYNTHETIC-EMPLOYEE', employee: '合成保存員工', minutes: 47, hourlyRateCents: 24000, amountCents: 18800, ...changes });
const report = (kind, rows = [kind === 'fees' ? fee() : payroll()], changes = {}) => ({
  title: kind === 'fees' ? '費用試算（未核定規則）' : '薪資試算（未核定規則）',
  columns: columns[kind].map(([key, label]) => ({ key, label })), rows,
  totals: { count: rows.length, amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0), ...(kind === 'payroll' ? { minutes: rows.reduce((sum, row) => sum + row.minutes, 0) } : {}) }, note, ...changes,
});
const rejected = (kind, result, ...captured) => assert.throws(() => confirmFinancialReport(kind, result, captured.length ? captured[0] : month), error => {
  assert.equal(error.code, 'REPORT_UNCONFIRMED');
  assert.equal(error.message, '未取得完整且一致的試算報表，請重新讀取。');
  return true;
});
const freezeDeep = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); }
  return value;
};

test('financial confirmation returns the same frozen payload without repairing raw strings source order or saved amounts', () => {
  const raw = '  =SYNTHETIC("quoted")\n<script>TEXT</script>  ';
  for (const [kind, rows] of [
    ['fees', [fee({ date: '2026-10-31', case: raw, serviceCode: '', service: raw, amountCents: 17 }), fee({ date: '2026-10-01', quantity: 1, unitPriceCents: 0, amountCents: 0 })]],
    ['payroll', [payroll({ employeeNo: raw, employee: '', minutes: 3000, hourlyRateCents: 0, amountCents: 19 }), payroll({ minutes: 1, hourlyRateCents: 1000000000, amountCents: 0 })]],
  ]) {
    const result = freezeDeep(report(kind, rows)), before = JSON.stringify(result);
    assert.equal(confirmFinancialReport(kind, result, month), result);
    assert.equal(JSON.stringify(result), before);
    assert.equal(result.rows[0].amountCents, kind === 'fees' ? 17 : 19, 'Confirmation must not recompute saved amounts using quantity, rate or minutes');
    assert.deepEqual(Object.keys(result), ['title', 'columns', 'rows', 'totals', 'note']);
  }
});

test('financial identity uses the captured supported kind exact title and explanatory note rather than invented query or organization echoes', () => {
  for (const kind of ['fees', 'payroll']) {
    for (const change of [{ title: '正式薪資' }, { title: report(kind === 'fees' ? 'payroll' : 'fees').title }, { title: report(kind).title + ' ' }, { note: '' }, { note: note.replace('不可作正式申報。', '') }, { note: note + ' ' }]) rejected(kind, report(kind, undefined, change));
    for (const extra of [{ organization: { name: '合成機構' } }, { filters: { month } }, { generatedAt: '2026-10-08T01:00:00Z' }]) rejected(kind, report(kind, undefined, extra));
  }
  for (const kind of ['services', 'cases', 'constructor', '__proto__', '', null, undefined, {}, ['fees']]) rejected(kind, report('fees'));
  const noEcho = report('payroll');
  assert.equal(confirmFinancialReport('payroll', noEcho, '2026-11'), noEcho, 'The legacy payroll DTO has no month echo and confirmation must not invent one');
});

test('financial confirmation rejects missing or unknown envelope and row properties without treating an incomplete body as an empty report', () => {
  for (const kind of ['fees', 'payroll']) {
    for (const value of [undefined, null, {}, [], '', 0, false]) rejected(kind, value);
    for (const key of ['title', 'columns', 'rows', 'totals', 'note']) { const result = report(kind); delete result[key]; rejected(kind, result); }
    for (const change of [{ rows: null }, { rows: {} }, { rows: '[]' }, { rows: [null] }, { rows: [[]] }, { totals: [] }, { totals: null }, { columns: null }, { columns: {} }]) rejected(kind, report(kind, undefined, change));
    const extra = report(kind); extra.rows[0].billingSnapshot = { private: 'synthetic' }; rejected(kind, extra);
    for (const key of Object.keys(report(kind).rows[0])) { const result = report(kind); delete result.rows[0][key]; rejected(kind, result); }
    const inherited = report(kind); inherited.rows[0] = Object.create(inherited.rows[0]); rejected(kind, inherited);
  }
});

test('financial columns must retain the exact ordered key label pairs and exclude format or private metadata', () => {
  for (const kind of ['fees', 'payroll']) {
    for (const mutation of [
      result => result.columns.reverse(),
      result => result.columns.pop(),
      result => result.columns.push({ key: 'phone', label: '合成電話' }),
      result => { result.columns[0].label += ' '; },
      result => { result.columns[0].key = 'unknown'; },
      result => { result.columns[0].format = 'official'; },
      result => { delete result.columns[0].label; },
      result => { result.columns[0] = [result.columns[0].key, result.columns[0].label]; },
    ]) { const result = report(kind); mutation(result); rejected(kind, result); }
  }
});

test('fee dates use literal captured month prefixes without stricter date parsing trimming fallback or text coercion', () => {
  for (const date of ['2026-10', '2026-10-not-a-date', '2026-1001', '2026-10-09T23:59:00-04:00', '2026-10-09 ', '2026-10\nSYNTHETIC']) {
    const result = report('fees', [fee({ date })]); assert.equal(confirmFinancialReport('fees', result, month), result); assert.equal(result.rows[0].date, date);
  }
  for (const date of [' 2026-10-09', '\n2026-10-09', '2026-11-01', '2026-1-09', '', null, 20261009, ['2026-10-09'], { date: '2026-10-09' }]) rejected('fees', report('fees', [fee({ date })]));
  const zeroYear = report('fees', [fee({ date: '0000-02-29' })]); assert.equal(confirmFinancialReport('fees', zeroYear, '0000-02'), zeroYear);
  for (const invalidMonth of ['', undefined, null, '2026-1', '2026-00', '2026-13', '2026-10-01', ' 2026-10', '2026-10 ', 202610, ['2026-10']]) for (const kind of ['fees', 'payroll']) rejected(kind, report(kind), invalidMonth);
  for (const [kind, fields] of [['fees', ['case', 'serviceCode', 'service']], ['payroll', ['employeeNo', 'employee']]]) for (const field of fields) for (const value of [null, 1, false, [], ['TEXT'], { text: 'TEXT' }]) {
    const result = report(kind); result.rows[0][field] = value; rejected(kind, result);
  }
});

test('fee quantities saved prices and amounts reject strings fractions negatives and unsafe values at the established writer boundaries', () => {
  for (const quantity of [1, 10000]) assert.equal(confirmFinancialReport('fees', report('fees', [fee({ quantity })]), month).rows[0].quantity, quantity);
  for (const quantity of [0, -1, 10001, 1.5, '2', null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2n]) rejected('fees', report('fees', [fee({ quantity })]));
  for (const unitPriceCents of [0, 1000000000]) assert.equal(confirmFinancialReport('fees', report('fees', [fee({ unitPriceCents })]), month).rows[0].unitPriceCents, unitPriceCents);
  for (const unitPriceCents of [-1, 1000000001, 0.5, '0', null, false, NaN, Infinity]) rejected('fees', report('fees', [fee({ unitPriceCents })]));
  for (const amountCents of [-1, 0.5, '0', null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejected('fees', report('fees', [fee({ amountCents })]));
  const safeMaximum = report('fees', [fee({ amountCents: Number.MAX_SAFE_INTEGER })]); assert.equal(confirmFinancialReport('fees', safeMaximum, month), safeMaximum);
});

test('payroll aggregated minutes can exceed one day while saved rates and stored amounts retain zero and safe integer limits', () => {
  for (const minutes of [1, 1440, 60000, Number.MAX_SAFE_INTEGER]) { const result = report('payroll', [payroll({ minutes, hourlyRateCents: 0, amountCents: 0 })]); assert.equal(confirmFinancialReport('payroll', result, month), result); }
  for (const minutes of [0, -1, 0.5, '47', null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejected('payroll', report('payroll', [payroll({ minutes })]));
  for (const hourlyRateCents of [0, 1000000000]) assert.equal(confirmFinancialReport('payroll', report('payroll', [payroll({ hourlyRateCents })]), month).rows[0].hourlyRateCents, hourlyRateCents);
  for (const hourlyRateCents of [-1, 1000000001, 0.5, '0', null, false, NaN, Infinity]) rejected('payroll', report('payroll', [payroll({ hourlyRateCents })]));
  for (const amountCents of [-1, 0.5, '0', null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejected('payroll', report('payroll', [payroll({ amountCents })]));
});

test('financial totals must match every supplied row safely instead of using fallback values or accepting rounding overflow', () => {
  for (const kind of ['fees', 'payroll']) {
    const valid = report(kind);
    for (const field of Object.keys(valid.totals)) {
      for (const value of [undefined, null, '', '0', false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, valid.totals[field] + 1]) rejected(kind, { ...valid, totals: { ...valid.totals, [field]: value } });
      const missing = { ...valid.totals }; delete missing[field]; rejected(kind, { ...valid, totals: missing });
    }
    rejected(kind, { ...valid, totals: { ...valid.totals, approved: 1 } });
    const row = kind === 'fees' ? fee : payroll;
    rejected(kind, report(kind, [row({ amountCents: Number.MAX_SAFE_INTEGER }), row({ amountCents: 1 })]));
    rejected(kind, report(kind, [row({ amountCents: Number.MAX_SAFE_INTEGER }), row({ amountCents: 2 })], { totals: { count: 2, amountCents: Number.MAX_SAFE_INTEGER, ...(kind === 'payroll' ? { minutes: 94 } : {}) } }));
  }
  rejected('payroll', report('payroll', [payroll({ minutes: Number.MAX_SAFE_INTEGER, amountCents: 0 }), payroll({ minutes: 1, amountCents: 0 })]));
});

test('empty financial reports and nonempty zero-money reports are distinguishable valid payloads with exact zero totals', () => {
  for (const kind of ['fees', 'payroll']) {
    const empty = freezeDeep(report(kind, [])); assert.equal(confirmFinancialReport(kind, empty, month), empty);
    assert.deepEqual(empty.totals, { count: 0, amountCents: 0, ...(kind === 'payroll' ? { minutes: 0 } : {}) });
    const zero = report(kind, [kind === 'fees' ? fee({ unitPriceCents: 0, amountCents: 0 }) : payroll({ hourlyRateCents: 0, amountCents: 0 })]);
    assert.equal(confirmFinancialReport(kind, zero, month), zero); assert.equal(zero.totals.count, 1);
    for (const field of Object.keys(empty.totals)) rejected(kind, { ...empty, totals: { ...empty.totals, [field]: 1 } });
    rejected(kind, { ...empty, rows: undefined });
  }
});

test('identical visible fee and payroll rows remain valid because the legacy projection exposes no record or employee group identity', () => {
  for (const kind of ['fees', 'payroll']) {
    const row = kind === 'fees' ? fee() : payroll(), result = freezeDeep(report(kind, [structuredClone(row), structuredClone(row)]));
    assert.equal(confirmFinancialReport(kind, result, month), result);
    assert.equal(result.totals.count, 2); assert.deepEqual(result.rows[0], result.rows[1]);
    assert.equal(Object.hasOwn(result.rows[0], 'id'), false); assert.equal(Object.hasOwn(result.rows[0], 'employeeId'), false);
  }
});
