import { dateValid, fail, scopedRows } from './model.mjs';
import { guardPersonnelAccess } from './personnel.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit, safeVersionReader } from './report-query.mjs';

const statusLabels = Object.freeze({ completed: '已完成', cancelled: '已取消' });
const categoryLabels = Object.freeze({ pre_service: '職前訓練', in_service: '在職訓練', other: '其他訓練' });
const columns = [
  ['date', '訓練日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'],
  ['name', '課程名稱'], ['categoryLabel', '訓練類別'], ['provider', '辦訓單位'],
  ['trainingMinutes', '訓練時間（分鐘）'], ['statusLabel', '訓練狀態'], ['note', '訓練備註'],
].map(([key, label]) => Object.freeze({ key, label }));
const text = value => typeof value === 'string' ? value : '';
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const label = (labels, value) => typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : '';
const invalid = () => fail(409, 'REPORT_DATA_INVALID', '符合條件的訓練紀錄含無法判讀的日期、識別碼、版次、狀態、類別或分鐘數，請先確認原紀錄');

function matchesSearch(training, employee, query) {
  if (!query) return true;
  return [employee?.employeeNo, employee?.name, training.name, training.provider, training.note,
    label(categoryLabels, training.category), label(statusLabels, training.status)]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
}

/** Saved training keeps its original scope even when the current employee lookup is unavailable. */
export function readTrainingReport(db, ctx, params, { full = false } = {}) {
  guardPersonnelAccess('employee-training', ctx, true, fail);
  const { filters, page, pageSize } = parseReportQuery(params, {
    full, statusLabels, statusMessage: '不支援的訓練狀態', caseFilter: false, search: true,
  });
  const reader = safeVersionReader(db);
  const employees = new Map(scopedRows(reader, ctx, 'employees').map(employee => [employee.id, employee]));
  validateReportReferences(filters, new Map(), employees);
  const query = filters.q.toLowerCase();
  const candidates = scopedRows(reader, ctx, 'employee-training').filter(training =>
    (!filters.employeeId || training.employeeId === filters.employeeId) &&
    (!filters.status || training.status === filters.status) && matchesSearch(training, employees.get(training.employeeId), query));
  for (const training of candidates) if (!dateValid(training.date)) invalid();
  const matching = candidates.filter(training => training.date >= filters.startDate && training.date <= filters.endDate);
  const projected = matching.map(training => {
    if (typeof training.id !== 'string' || !training.id || !Number.isSafeInteger(training.version) || training.version < 1 ||
        !label(statusLabels, training.status) || !label(categoryLabels, training.category) ||
        !Number.isSafeInteger(training.trainingMinutes) || training.trainingMinutes < 1 || training.trainingMinutes > 60000) invalid();
    const employee = employees.get(training.employeeId);
    return {
      trainingId: training.id, version: training.version, date: training.date, employeeId: text(training.employeeId),
      employeeNo: text(employee?.employeeNo), employee: text(employee?.name), name: text(training.name),
      category: training.category, categoryLabel: categoryLabels[training.category], provider: text(training.provider),
      trainingMinutes: training.trainingMinutes, status: training.status, statusLabel: statusLabels[training.status], note: text(training.note),
    };
  });
  if (full) assertReportExportLimit(projected.length);
  projected.sort((a, b) => compareText(a.date, b.date) || compareText(a.employeeNo, b.employeeNo) ||
    compareText(a.name, b.name) || compareText(a.trainingId, b.trainingId));
  const total = projected.length;
  const selectedName = filters.employeeId ? text(employees.get(filters.employeeId)?.name) : '';
  const result = {
    title: '教育訓練紀錄總表',
    organization: { name: db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId)?.name || '' },
    filters,
    selection: {
      employee: filters.employeeId ? selectedName.trim() ? selectedName : '名稱未取得' : '全部可讀員工',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機保存教育訓練紀錄，使用目前可讀員工名稱；名稱缺失以「—」呈現。訓練時間保留保存分鐘，不換算法定積分或資格；尚未核定正式表單規則，不作完成時數、薪資或資格認定。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
