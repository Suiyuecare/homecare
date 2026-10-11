import { spanReportRows, spanReportColumns } from './span-report.mjs';
import { entitySpan } from './shift-span.mjs';
import { dateValid, fail, scopedRows, timeMinute } from './model.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit, safeVersionReader } from './report-query.mjs';

const statusLabels = Object.freeze({ pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消' });
const columns = [
  ['date', '請假日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'],
  ['startTime', '開始時間'], ['endTime', '結束時間'], ['type', '假別'],
  ['statusLabel', '請假狀態'], ['reason', '請假原因'],
].map(([key, label]) => Object.freeze({ key, label }));
const text = value => typeof value === 'string' ? value : '';
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const invalid = () => fail(409, 'REPORT_DATA_INVALID', '符合條件的請假紀錄含無法判讀的日期、識別碼、版次、狀態或時段，請先確認原紀錄');

function matchesSearch(leave, employee, query) {
  if (!query) return true;
  const label = typeof leave.status === 'string' && Object.hasOwn(statusLabels, leave.status) ? statusLabels[leave.status] : '';
  return [employee?.employeeNo, employee?.name, leave.type, leave.reason, label]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
}

/** Saved leave remains readable even when its current employee lookup is unavailable. */
export function readLeaveReport(db, ctx, params, { full = false } = {}) {
  const { filters, page, pageSize } = parseReportQuery(params, {
    full, statusLabels, statusMessage: '不支援的請假狀態', caseFilter: false, search: true, span:true,
  });
  const reader = safeVersionReader(db);
  const employees = new Map(scopedRows(reader, ctx, 'employees').map(employee => [employee.id, employee]));
  validateReportReferences(filters, new Map(), employees);
  const query = filters.q.toLowerCase();
  const candidates = scopedRows(reader, ctx, 'leave-requests').filter(leave =>
    (!filters.employeeId || leave.employeeId === filters.employeeId) &&
    (!filters.status || leave.status === filters.status) && matchesSearch(leave, employees.get(leave.employeeId), query));
  for (const leave of candidates) if (!dateValid(leave.date)) invalid();
  const matching = filters.spanMode ? spanReportRows(db,ctx,'leave-requests',filters).filter(leave=>matchesSearch(leave,employees.get(leave.employeeId),query)) : candidates.filter(leave => leave.date >= filters.startDate && leave.date <= filters.endDate);
  if(!filters.spanMode&&matching.some(leave=>Object.hasOwn(leave,'endDate')))fail(409,'SPAN_VIEW_REQUIRED','請以完整日期模式讀取含結束日的請假。');
  const projected = matching.map(leave => {
    const start = timeMinute(leave.startTime, leave.date), end = timeMinute(leave.endTime, leave.date);
    if (typeof leave.id !== 'string' || !leave.id || !Number.isSafeInteger(leave.version) || leave.version < 1 ||
        typeof leave.status !== 'string' || !Object.hasOwn(statusLabels, leave.status) ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (!filters.spanMode && end <= start)) invalid();
    const employee = employees.get(leave.employeeId);
    return {
      leaveId: leave.id, version: leave.version, date: leave.date, employeeId: text(leave.employeeId), ...(filters.spanMode?{endDate:Object.hasOwn(leave,'endDate')?leave.endDate:leave.date}:{}),
      employeeNo: text(employee?.employeeNo), employee: text(employee?.name),
      startTime: leave.startTime, endTime: leave.endTime, type: text(leave.type), reason: text(leave.reason),
      status: leave.status, statusLabel: statusLabels[leave.status],
    };
  });
  if (full) assertReportExportLimit(projected.length);
  projected.sort((a, b) => compareText(a.date, b.date) ||
    compareText(timeMinute(a.startTime, a.date), timeMinute(b.startTime, b.date)) ||
    compareText(a.employeeNo, b.employeeNo) || compareText(a.leaveId, b.leaveId));
  const total = projected.length;
  const selectedName = filters.employeeId ? text(employees.get(filters.employeeId)?.name) : '';
  const result = {
    title: '請假紀錄總表',
    organization: { name: db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId)?.name || '' },
    filters,
    selection: {
      employee: filters.employeeId ? selectedName.trim() ? selectedName : '名稱未取得' : '全部可讀員工',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns:spanReportColumns(columns,'endDate','結束日期',filters),
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機保存請假紀錄，使用目前可讀員工名稱；名稱缺失以「—」呈現。假別與原因保留原文字，尚未核定假額、薪資或正式表單規則，不作法定時數或扣薪推算。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
