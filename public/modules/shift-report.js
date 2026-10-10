import { mountReportView } from './report-view.js';

export const shiftReportConfig = Object.freeze({
  key: 'shift-report', path: '/api/shift-report', title: '班表明細', idKey: 'shiftId', statusLabel: '班次狀態',
  statuses: Object.freeze({ scheduled: '已排班', completed: '已完成', cancelled: '已取消' }),
  columns: Object.freeze([
    ['date', '日期'], ['caseNo', '案號'], ['case', '個案'], ['employeeNo', '員工編號'],
    ['employee', '服務人員'], ['startTime', '開始'], ['endTime', '結束'],
    ['services', '排班服務與數量'], ['statusLabel', '狀態'], ['version', '版次'], ['note', '交班備註'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    shiftId: 'string', version: 'positiveInteger', date: 'string', caseNo: 'string', case: 'string',
    employeeNo: 'string', employee: 'string', startTime: 'string', endTime: 'string', services: 'string',
    status: 'string', statusLabel: 'string', note: 'string',
  }),
  copy: Object.freeze({
    queryTitle: '排班明細查詢', queryButton: '查詢排班',
    help: '查詢期間最多 366 日；下載與列印會重新讀取目前班次。',
    queryLoading: '正在查詢排班…', tableLoading: '正在讀取班表明細…',
    previewTitle: '班表明細列印預覽', previewLoading: '正在重新讀取完整班表…',
    resultLabel: '班表查詢結果', completeLabel: '完整班表明細',
    emptyTable: '沒有符合條件的班次，請調整查詢。',
    emptyResult: '沒有符合條件的班次，下載與列印已停用。',
    emptyExport: '目前已無符合條件的班次，請重新查詢。',
    downloadSuccess: '班表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 班次${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountShiftReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: shiftReportConfig, isCurrent });
}
