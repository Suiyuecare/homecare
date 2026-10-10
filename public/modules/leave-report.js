import { mountReportView } from './report-view.js';

// Preserve the existing model.timeMinute contract and all saved time text.
// The comparison checks same-day HH:mm components; it does not calculate leave hours.
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

export const leaveReportConfig = Object.freeze({
  key: 'leave-report', path: '/api/leave-report', title: '請假紀錄總表', idKey: 'leaveId', statusLabel: '請假狀態',
  statuses: Object.freeze({ pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消' }),
  date: Object.freeze({ rowKey: 'date', startLabel: '請假日期起', endLabel: '請假日期迄', rangeLabel: '請假日期範圍' }),
  caseFilter: false,
  search: Object.freeze({ key: 'q', label: '關鍵字', placeholder: '搜尋員工編號、姓名、假別或請假原因', maxLength: 200 }),
  personFilter: Object.freeze({ key: 'employeeId', selectionKey: 'employee', label: '員工', emptyLabel: '全部可讀員工' }),
  columns: Object.freeze([
    ['date', '請假日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'],
    ['startTime', '開始時間'], ['endTime', '結束時間'], ['type', '假別'],
    ['statusLabel', '請假狀態'], ['reason', '請假原因'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    leaveId: 'string', version: 'positiveInteger', date: 'string', employeeId: 'string',
    employeeNo: 'string', employee: 'string', startTime: 'string', endTime: 'string',
    type: 'string', reason: 'string', status: 'string', statusLabel: 'string',
  }),
  validateRow: (row, { filters }) => {
    if (filters.employeeId && row.employeeId !== filters.employeeId) return false;
    const start = savedTimeMinute(row.startTime, row.date), end = savedTimeMinute(row.endTime, row.date);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
    if (!filters.q) return true;
    return [row.employeeNo, row.employee, row.type, row.reason, row.statusLabel]
      .some(value => value.toLowerCase().includes(filters.q.toLowerCase()));
  },
  validateTotals: result => Object.keys(result.totals).length === 1 && Object.hasOwn(result.totals, 'count'),
  copy: Object.freeze({
    queryTitle: '請假紀錄總表查詢', queryButton: '查詢請假',
    help: '依保存的請假日期查詢，期間最多 366 日。時段保留原文；下載與列印會重新讀取完整紀錄，不計算請假時數或假額。',
    queryLoading: '正在查詢請假紀錄…', tableLoading: '正在讀取請假紀錄總表…',
    previewTitle: '請假紀錄總表列印預覽', previewLoading: '正在重新讀取完整請假紀錄…',
    resultLabel: '請假紀錄總表查詢結果', completeLabel: '完整請假紀錄總表',
    emptyTable: '沒有符合條件的請假紀錄，請調整查詢。',
    emptyResult: '沒有符合條件的請假紀錄，下載與列印已停用。',
    emptyExport: '目前已無符合條件的請假紀錄，請重新查詢。',
    downloadSuccess: '請假紀錄總表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 筆請假紀錄${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountLeaveReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: leaveReportConfig, isCurrent });
}
