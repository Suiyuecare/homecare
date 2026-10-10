import { dateValid, fail, scopedRows, timeMinute } from './model.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit } from './report-query.mjs';

const statusLabels = Object.freeze({ draft: '草稿', submitted: '待核閱', approved: '已核准', returned: '退回修改' });
const columns = [
  ['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'],
  ['employee', '服務人員'], ['actualStart', '實際開始'], ['actualEnd', '實際結束'],
  ['serviceMinutes', '實際分鐘'], ['services', '實際服務與數量'], ['statusLabel', '核閱狀態'],
  ['version', '版次'], ['note', '服務備註'], ['reviewNote', '核閱意見'],
].map(([key, label]) => Object.freeze({ key, label }));
const text = value => typeof value === 'string' ? value : '';
const display = (value, fallback) => text(value) || fallback;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Reads actual recorded quantities and times, independently of any billing snapshot. */
export function readServiceReport(db, ctx, params, { full = false } = {}) {
  const { filters, page, pageSize } = parseReportQuery(params, { full, statusLabels, statusMessage: '不支援的紀錄狀態' });
  const cases = new Map(scopedRows(db, ctx, 'cases').map(item => [item.id, item]));
  const employees = new Map(scopedRows(db, ctx, 'employees').map(item => [item.id, item]));
  validateReportReferences(filters, cases, employees);
  const records = scopedRows(db, ctx, 'service-records').filter(item =>
    item.date >= filters.startDate && item.date <= filters.endDate &&
    (!filters.caseId || item.caseId === filters.caseId) &&
    (!filters.employeeId || item.employeeId === filters.employeeId) &&
    (!filters.status || item.status === filters.status));
  const services = new Map(scopedRows(db, ctx, 'service-items').map(item => [item.id, item]));
  let serviceMinutes = 0;
  const projected = records.map(record => {
    const start = timeMinute(record.actualStart, record.date), end = timeMinute(record.actualEnd, record.date);
    const minutes = end - start;
    if (!dateValid(record.date) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(minutes) || minutes <= 0) {
      fail(409, 'REPORT_DATA_INVALID', '符合條件的服務紀錄包含無效起訖時間，請先核對資料；本次未輸出報表。');
    }
    serviceMinutes += minutes;
    const caseItem = cases.get(record.caseId), employee = employees.get(record.employeeId);
    const serviceText = (Array.isArray(record.services) ? record.services : []).map(service => {
      const item = services.get(service.serviceItemId);
      const name = [text(item?.code), display(item?.name, '未取得服務名稱')].filter(Boolean).join(' ');
      return name + ' × ' + service.quantity;
    }).join('；');
    return {
      recordId: record.id, version: record.version, date: text(record.date),
      caseNo: text(caseItem?.caseNo), case: display(caseItem?.name, '未取得個案名稱'),
      employeeNo: text(employee?.employeeNo), employee: display(employee?.name, '未取得服務人員名稱'),
      actualStart: record.actualStart, actualEnd: record.actualEnd, serviceMinutes: minutes, services: serviceText,
      status: text(record.status), statusLabel: statusLabels[record.status] || '未取得狀態',
      note: text(record.note), reviewNote: text(record.reviewNote),
    };
  });
  if (full) assertReportExportLimit(projected.length);
  projected.sort((a, b) => {
    for (const key of ['date', 'actualStart', 'caseNo', 'employeeNo', 'recordId']) {
      const result = key === 'actualStart'
        ? compareText(timeMinute(a.actualStart, a.date), timeMinute(b.actualStart, b.date))
        : compareText(a[key], b[key]);
      if (result) return result;
    }
    return 0;
  });
  const total = projected.length;
  const organization = db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId);
  const result = {
    title: '服務紀錄明細', organization: { name: organization?.name || '未取得機構名稱' }, filters,
    selection: {
      case: filters.caseId ? display(cases.get(filters.caseId)?.name, '未取得個案名稱') : '全部可讀個案',
      employee: filters.employeeId ? display(employees.get(filters.employeeId)?.name, '未取得服務人員名稱') : '全部可讀人員',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total, serviceMinutes }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機測試報表；個案、人員與服務使用目前主檔名稱，數量為實際紀錄數量，分鐘包含所選草稿、待核閱、退回修改及已核准狀態；非正式申報與薪資依據。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
