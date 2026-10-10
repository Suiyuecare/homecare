import { mountReportView } from './report-view.js';

// Match the persisted timeMinute contract: validate ISO text, but compare its saved
// same-day HH:mm components. Seconds and offsets do not change this local measure.
const savedTimeMinute = (value, date) => {
  if (typeof value !== 'string') return NaN;
  if (/^\d{2}:\d{2}$/.test(value)) {
    const [hour, minute] = value.split(':').map(Number);
    return hour < 24 && minute < 60 ? hour * 60 + minute : NaN;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && value.slice(0, 10) === date && Number.isFinite(Date.parse(value))) {
    return savedTimeMinute(value.slice(11, 16), date);
  }
  return NaN;
};

export const serviceReportConfig = Object.freeze({
  key: 'service-report', path: '/api/service-report', title: '服務紀錄明細', idKey: 'recordId', statusLabel: '核閱狀態',
  statuses: Object.freeze({ draft: '草稿', submitted: '待核閱', approved: '已核准', returned: '退回修改' }),
  columns: Object.freeze([
    ['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'],
    ['employee', '服務人員'], ['actualStart', '實際開始'], ['actualEnd', '實際結束'],
    ['serviceMinutes', '實際分鐘'], ['services', '實際服務與數量'], ['statusLabel', '核閱狀態'],
    ['version', '版次'], ['note', '服務備註'], ['reviewNote', '核閱意見'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    recordId: 'string', version: 'positiveInteger', date: 'string', caseNo: 'string', case: 'string',
    employeeNo: 'string', employee: 'string', actualStart: 'string', actualEnd: 'string',
    serviceMinutes: 'positiveInteger', services: 'string', status: 'string', statusLabel: 'string', note: 'string', reviewNote: 'string',
  }),
  validateRow: row => {
    const start = savedTimeMinute(row.actualStart, row.date), end = savedTimeMinute(row.actualEnd, row.date);
    return Number.isFinite(start) && Number.isFinite(end) && end > start && row.serviceMinutes === end - start;
  },
  validateTotals: (result, { complete }) => {
    const minutes = result.totals.serviceMinutes;
    const pageMinutes = result.rows.reduce((total, row) => total + row.serviceMinutes, 0);
    return Number.isSafeInteger(minutes) && minutes >= 0 && Number.isSafeInteger(pageMinutes)
      && (result.total !== 0 || minutes === 0) && minutes >= result.total
      && (complete ? pageMinutes === minutes : pageMinutes <= minutes);
  },
  copy: Object.freeze({
    queryTitle: '服務紀錄明細查詢', queryButton: '查詢紀錄',
    help: '查詢期間最多 366 日；下載與列印會重新讀取目前服務紀錄。',
    queryLoading: '正在查詢服務紀錄…', tableLoading: '正在讀取服務紀錄明細…',
    previewTitle: '服務紀錄明細列印預覽', previewLoading: '正在重新讀取完整服務紀錄…',
    resultLabel: '服務紀錄查詢結果', completeLabel: '完整服務紀錄明細',
    emptyTable: '沒有符合條件的紀錄，請調整查詢。',
    emptyResult: '沒有符合條件的紀錄，下載與列印已停用。',
    emptyExport: '目前已無符合條件的紀錄，請重新查詢。',
    downloadSuccess: '服務紀錄 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 筆紀錄；實際分鐘合計 ${result.totals.serviceMinutes} 分鐘${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountServiceReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: serviceReportConfig, isCurrent });
}
