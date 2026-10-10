import { scopedRows } from './model.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit } from './report-query.mjs';
const statusLabels = Object.freeze({ scheduled: '已排班', completed: '已完成', cancelled: '已取消' });
const columns = [
  ['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'],
  ['employee', '服務人員'], ['startTime', '開始'], ['endTime', '結束'],
  ['services', '排班服務與數量'], ['statusLabel', '狀態'], ['version', '版次'], ['note', '交班備註'],
].map(([key, label]) => Object.freeze({ key, label }));

const text = value => typeof value === 'string' ? value : '';
const display = (value, fallback) => text(value) || fallback;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Fresh scoped reads only. Full exports and paginated lists use this same projection. */
export function readShiftReport(db, ctx, params, { full = false } = {}) {
  const { filters, page, pageSize } = parseReportQuery(params, { full, statusLabels, statusMessage: '不支援的班次狀態' });
  const cases = new Map(scopedRows(db, ctx, 'cases').map(item => [item.id, item]));
  const employees = new Map(scopedRows(db, ctx, 'employees').map(item => [item.id, item]));
  validateReportReferences(filters, cases, employees);
  const shifts = scopedRows(db, ctx, 'shifts').filter(item =>
    item.date >= filters.startDate && item.date <= filters.endDate &&
    (!filters.caseId || item.caseId === filters.caseId) &&
    (!filters.employeeId || item.employeeId === filters.employeeId) &&
    (!filters.status || item.status === filters.status));
  if (full) assertReportExportLimit(shifts.length);
  const services = new Map(scopedRows(db, ctx, 'service-items').map(item => [item.id, item]));
  const projected = shifts.map(shift => {
    const caseItem = cases.get(shift.caseId), employee = employees.get(shift.employeeId);
    const serviceText = (Array.isArray(shift.services) ? shift.services : []).map(service => {
      const item = services.get(service.serviceItemId);
      const name = [text(item?.code), display(item?.name, '未取得服務名稱')].filter(Boolean).join(' ');
      return name + ' × ' + service.quantity;
    }).join('；');
    return {
      shiftId: shift.id, version: shift.version, date: text(shift.date),
      caseNo: text(caseItem?.caseNo), case: display(caseItem?.name, '未取得個案名稱'),
      employeeNo: text(employee?.employeeNo), employee: display(employee?.name, '未取得服務人員名稱'),
      startTime: text(shift.startTime), endTime: text(shift.endTime), services: serviceText,
      status: text(shift.status), statusLabel: statusLabels[shift.status] || '未取得狀態', note: text(shift.note),
    };
  });
  projected.sort((a, b) => {
    for (const key of ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId']) {
      const result = compareText(a[key], b[key]);
      if (result) return result;
    }
    return 0;
  });
  const total = projected.length;
  const organization = db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId);
  const result = {
    title: '班表明細', organization: { name: organization?.name || '未取得機構名稱' }, filters,
    selection: {
      case: filters.caseId ? display(cases.get(filters.caseId)?.name, '未取得個案名稱') : '全部可讀個案',
      employee: filters.employeeId ? display(employees.get(filters.employeeId)?.name, '未取得服務人員名稱') : '全部可讀人員',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機測試報表；個案、人員與服務使用目前主檔名稱，服務數量為排班數量，非正式申報。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
