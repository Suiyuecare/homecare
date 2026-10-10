import test from 'node:test';
import assert from 'node:assert/strict';

// Only module loading needs a browser-shaped global; confirmation never mounts a view.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { confirmReport } = await import('../public/modules/report-view.js');
const { trainingReportConfig: config } = await import('../public/modules/training-report.js');

const columns = [
  ['date', '訓練日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'],
  ['name', '課程名稱'], ['categoryLabel', '訓練類別'], ['provider', '辦訓單位'],
  ['trainingMinutes', '訓練時間（分鐘）'], ['statusLabel', '訓練狀態'], ['note', '訓練備註'],
].map(([key, label]) => ({ key, label }));
const filters = () => ({ startDate: '2026-10-01', endDate: '2026-10-31', q: '', employeeId: '', status: '' });
const row = (overrides = {}) => ({
  trainingId: 'training-synthetic-1', version: 1, date: '2026-10-08', employeeId: 'employee-synthetic-1',
  employeeNo: 'SYN-EMP-001', employee: '合成訓練員工', name: '合成課程', category: 'in_service',
  categoryLabel: '在職訓練', provider: '合成辦訓單位', trainingMinutes: 47, status: 'completed',
  statusLabel: '已完成', note: '保留原分鐘，非積分核定。', ...overrides,
});
const report = (rows = [row()], requestedFilters = filters(), overrides = {}) => ({
  title: '教育訓練紀錄總表', organization: { name: '合成測試機構' }, filters: { ...requestedFilters },
  selection: { employee: requestedFilters.employeeId ? '合成訓練員工' : '全部可讀員工', status: ({ completed: '已完成', cancelled: '已取消' })[requestedFilters.status] || '全部狀態' },
  generatedAt: '2026-10-08T13:30:00.000Z', columns: columns.map(column => ({ ...column })),
  rows, total: rows.length, totals: { count: rows.length }, page: 1, pageSize: 25,
  note: '本機保存訓練資料，姓名為目前名稱；分鐘非核定積分或資格。', ...overrides,
});
const confirmed = (result, requestedFilters = filters(), options) => confirmReport(config, result, requestedFilters, options);
const rejected = (result, requestedFilters = filters(), options) => assert.throws(
  () => confirmed(result, requestedFilters, options),
  /未取得與查詢條件一致的完整報表確認/,
);
const freezeDeep = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeDeep(item);
  }
  return value;
};

test('training confirmation keeps nine saved-data columns, raw minute boundaries and immutable count-only rows', () => {
  assert.deepEqual(config.columns, columns);
  assert.equal(config.caseFilter, false);
  assert.equal(config.personFilter.key, 'employeeId');
  assert.equal(config.search.key, 'q');
  assert.equal(config.search.maxLength, 200);
  const rows = [row({ trainingMinutes: 1 }), row({ trainingId: 'training-synthetic-2', trainingMinutes: 60000 })];
  const result = freezeDeep(report(rows));
  const original = JSON.stringify(result);
  assert.equal(confirmed(result), result);
  assert.equal(result.rows[0].trainingMinutes, 1);
  assert.equal(result.rows[1].trainingMinutes, 60000);
  assert.equal(JSON.stringify(result), original);
  assert.equal(Object.keys(result.rows[0]).length, 14);
  assert.deepEqual(result.totals, { count: 2 });
  assert.match(config.summary(result, { complete: false }), /2/);
});

test('training minutes and versions reject coercible strings, fractional or unsafe values without repairing source data', () => {
  for (const trainingMinutes of [undefined, null, '', '1', '47', '60000', true, false, [], [47], {}, 0, -1, 0.5, 47.5, 60001, Number.MAX_SAFE_INTEGER, NaN, Infinity, 47n]) {
    const result = report([row({ trainingMinutes })]);
    rejected(result);
    assert.equal(result.rows[0].trainingMinutes, trainingMinutes);
  }
  for (const version of [undefined, null, '', '1', false, [], 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    rejected(report([row({ version })]));
  }
  assert.equal(confirmed(report([row({ version: Number.MAX_SAFE_INTEGER })])).rows[0].version, Number.MAX_SAFE_INTEGER);
});

test('training category and status labels must match known codes and the exact row/column projection excludes extra metadata', () => {
  for (const [category, categoryLabel] of [['pre_service', '職前訓練'], ['in_service', '在職訓練'], ['other', '其他訓練']]) {
    assert.equal(confirmed(report([row({ category, categoryLabel })])).rows[0].categoryLabel, categoryLabel);
    rejected(report([row({ category, categoryLabel: '法定積分' })]));
  }
  for (const category of ['', 'unknown', 'constructor', '__proto__', null, ['in_service']]) rejected(report([row({ category })]));
  for (const change of [{ status: 'draft' }, { status: 'constructor' }, { status: 'cancelled' }, { statusLabel: '核定完成' }]) rejected(report([row(change)]));
  assert.equal(confirmed(report([row({ status: 'cancelled', statusLabel: '已取消' })])).rows[0].status, 'cancelled');
  for (const change of [{ phone: 'synthetic-private' }, { email: 'synthetic@example.test' }, { hourlyRateCents: 12345 }, { statutoryCredits: 8 }]) rejected(report([row(change)]));
  const missing = row(); delete missing.provider; rejected(report([missing]));
  const wrongColumns = report(); [wrongColumns.columns[0], wrongColumns.columns[1]] = [wrongColumns.columns[1], wrongColumns.columns[0]]; rejected(wrongColumns);
  const coercingColumn = report(); coercingColumn.columns[6].type = 'hours'; rejected(coercingColumn);
  const wrongLabel = report(); wrongLabel.columns[6].label = '法定積分'; rejected(wrongLabel);
});

test('training filter echoes, selection scope and explicit employee/status checks cannot confirm a different query', () => {
  const requested = { ...filters(), q: ' 合成 ', employeeId: 'employee-synthetic-1', status: 'completed' };
  const result = report([row({ name: '課程 合成 原文' })], requested);
  assert.equal(confirmed(result, requested), result);
  for (const change of [{ q: '合成' }, { employeeId: 'employee-other' }, { status: '' }, { startDate: '2026-10-02' }, { endDate: '2026-10-30' }, { category: '' }]) {
    rejected({ ...result, filters: { ...requested, ...change } }, requested);
  }
  rejected({ ...result, rows: [row({ employeeId: 'employee-other', name: '課程 合成 原文' })] }, requested);
  rejected({ ...result, rows: [row({ status: 'cancelled', statusLabel: '已取消', name: '課程 合成 原文' })] }, requested);
  rejected({ ...result, selection: { ...result.selection, status: '全部狀態' } }, requested);
  rejected({ ...result, selection: { ...result.selection, case: 'not-part-of-training' } }, requested);
  rejected({ ...report(), selection: { employee: '全部個案', status: '全部狀態' } });
  const missingCurrentName = report([row({ employeeId: 'saved-orphan-id', employee: '', employeeNo: '' })]);
  assert.equal(confirmed(missingCurrentName).rows[0].employee, '');
  const unnamedSelection = { ...filters(), employeeId: 'employee-synthetic-1' };
  const unnamed = report([row({ employee: '', employeeNo: '' })], unnamedSelection);
  unnamed.selection.employee = '名稱未取得';
  assert.equal(confirmed(unnamed, unnamedSelection), unnamed);
});

test('training keyword confirmation uses literal per-field text without trimming, joining fields or searching hidden identifiers and minutes', () => {
  for (const field of ['employeeNo', 'employee', 'name', 'provider', 'note']) {
    const requested = { ...filters(), q: 'abC[.*] ' };
    const result = report([row({ [field]: 'prefix ABC[.*] suffix' })], requested);
    assert.equal(confirmed(result, requested), result);
  }
  for (const q of ['在職訓練', '已完成']) {
    const requested = { ...filters(), q };
    assert.equal(confirmed(report([row()], requested), requested).rows.length, 1);
  }
  const excludedRow = row({ trainingId: 'hidden-training-99871', employeeId: 'hidden-employee-99872', version: 99873, trainingMinutes: 59999 });
  for (const q of ['hidden-training-99871', 'hidden-employee-99872', '99873', '59999', '2026-10-08', 'in_service', 'completed', ' 合成課程 ', '合成課程在職訓練']) {
    const requested = { ...filters(), q };
    rejected(report([excludedRow], requested), requested);
  }
  const fallbackQuery = { ...filters(), q: '名稱未取得' };
  rejected(report([row({ employee: '', employeeNo: '' })], fallbackQuery), fallbackQuery);
});

test('training saved dates must be real ISO dates within both inclusive query boundaries', () => {
  const requested = { ...filters(), startDate: '2026-02-01', endDate: '2026-03-01' };
  for (const date of ['2026-02-01', '2026-02-28', '2026-03-01']) {
    assert.equal(confirmed(report([row({ date })], requested), requested).rows[0].date, date);
  }
  for (const date of ['2026-02-29', '2026-02-30', '2026-01-31', '2026-03-02', '2026-2-01', '2026/02/01', '2026-02-01T00:00:00Z', '', null, 20260201]) {
    rejected(report([row({ date })], requested), requested);
  }
});

test('training pagination and full-export confirmation reject truncation, duplicate IDs, wrong page sizes and inferred totals', () => {
  const rows = Array.from({ length: 28 }, (_, index) => row({ trainingId: `training-${index + 1}` }));
  const first = report(rows.slice(0, 25), filters(), { total: 28, totals: { count: 28 } });
  const last = report(rows.slice(25), filters(), { total: 28, totals: { count: 28 }, page: 2 });
  const complete = report(rows, filters(), { pageSize: 28 });
  assert.equal(confirmed(first), first);
  assert.equal(confirmed(last, filters(), { page: 2 }), last);
  assert.equal(confirmed(complete, filters(), { complete: true }), complete);
  rejected(first, filters(), { complete: true });
  rejected({ ...complete, rows: rows.slice(0, 27) }, filters(), { complete: true });
  rejected({ ...complete, pageSize: 25 }, filters(), { complete: true });
  rejected({ ...last, page: 1 }, filters(), { page: 2 });
  rejected({ ...last, rows: [...last.rows, row({ trainingId: 'extra' })] }, filters(), { page: 2 });
  rejected(report([row(), row()]));
  for (const totals of [{ count: 0 }, { count: '1' }, { count: 1, minutes: 47 }, { count: 1, credits: 1 }, { count: 1, completedHours: 1 }]) rejected({ ...report(), totals });
  for (const total of [-1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) rejected({ ...report(), total });
});

test('training confirmation requires the report identity, current metadata and explanatory note while preserving a valid empty result', () => {
  for (const change of [
    { title: '正式積分總表' }, { organization: { name: '' } }, { organization: { name: ' ' } },
    { generatedAt: 'not-a-timestamp' }, { generatedAt: null }, { generatedAt: '2026-10-08' },
    { note: '' }, { note: ' ' }, { rows: null }, { columns: [] }, { selection: {} }, { filters: {} },
  ]) rejected({ ...report(), ...change });
  for (const value of [undefined, null, {}, []]) rejected(value);
  const empty = freezeDeep(report([]));
  assert.equal(confirmed(empty), empty);
  const completeEmpty = freezeDeep({ ...empty, pageSize: 0 });
  assert.equal(confirmed(completeEmpty, filters(), { complete: true }), completeEmpty);
  // The shared output controller disables zero-row CSV/print; confirmation only validates the envelope.
  assert.equal(empty.total, 0);
  assert.equal(empty.rows.length, 0);
});
