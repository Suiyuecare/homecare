import { mountReportView } from './report-view.js';

const categoryLabels = Object.freeze({ pre_service: '職前訓練', in_service: '在職訓練', other: '其他訓練' });

export const trainingReportConfig = Object.freeze({
  key: 'training-report', path: '/api/training-report', title: '教育訓練紀錄總表', idKey: 'trainingId', statusLabel: '訓練狀態',
  statuses: Object.freeze({ completed: '已完成', cancelled: '已取消' }),
  date: Object.freeze({ rowKey: 'date', startLabel: '訓練日期起', endLabel: '訓練日期迄', rangeLabel: '訓練日期範圍' }),
  caseFilter: false,
  search: Object.freeze({ key: 'q', label: '關鍵字', placeholder: '搜尋員工編號、姓名、課程、類別、辦訓單位或備註', maxLength: 200 }),
  personFilter: Object.freeze({ key: 'employeeId', selectionKey: 'employee', label: '員工', emptyLabel: '全部可讀員工' }),
  columns: Object.freeze([
    ['date', '訓練日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'],
    ['name', '課程名稱'], ['categoryLabel', '訓練類別'], ['provider', '辦訓單位'],
    ['trainingMinutes', '訓練時間（分鐘）'], ['statusLabel', '訓練狀態'], ['note', '訓練備註'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    trainingId: 'string', version: 'positiveInteger', date: 'string', employeeId: 'string',
    employeeNo: 'string', employee: 'string', name: 'string', category: 'string', categoryLabel: 'string',
    provider: 'string', trainingMinutes: 'positiveInteger', status: 'string', statusLabel: 'string', note: 'string',
  }),
  validateRow: (row, { filters }) => {
    if (filters.employeeId && row.employeeId !== filters.employeeId) return false;
    if (!Object.hasOwn(categoryLabels, row.category) || row.categoryLabel !== categoryLabels[row.category] || row.trainingMinutes > 60000) return false;
    if (!filters.q) return true;
    return [row.employeeNo, row.employee, row.name, row.provider, row.note, row.categoryLabel, row.statusLabel]
      .some(value => value.toLowerCase().includes(filters.q.toLowerCase()));
  },
  validateTotals: result => Object.keys(result.totals).length === 1 && Object.hasOwn(result.totals, 'count'),
  copy: Object.freeze({
    queryTitle: '教育訓練紀錄總表查詢', queryButton: '查詢訓練',
    help: '依保存的訓練日期查詢，期間最多 366 日。逐筆顯示保存分鐘，合計僅筆數；下載與列印重新讀取完整紀錄，不換算法定積分、資格或薪資。',
    queryLoading: '正在查詢訓練紀錄…', tableLoading: '正在讀取教育訓練紀錄總表…',
    previewTitle: '教育訓練紀錄總表列印預覽', previewLoading: '正在重新讀取完整訓練紀錄…',
    resultLabel: '教育訓練紀錄總表查詢結果', completeLabel: '完整教育訓練紀錄總表',
    emptyTable: '沒有符合條件的訓練紀錄，請調整查詢。',
    emptyResult: '沒有符合條件的訓練紀錄，下載與列印已停用。',
    emptyExport: '目前已無符合條件的訓練紀錄，請重新查詢。',
    downloadSuccess: '教育訓練紀錄總表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 筆訓練紀錄${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountTrainingReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: trainingReportConfig, isCurrent });
}
