import { mountReportView } from './report-view.js';

export const employeeReportConfig = Object.freeze({
  key: 'employee-report', path: '/api/employee-report', title: '員工總表', idKey: 'employeeId', statusLabel: '員工狀態',
  statuses: Object.freeze({ active: '啟用', inactive: '停用' }),
  date: false, caseFilter: false,
  search: Object.freeze({ key: 'q', label: '關鍵字', placeholder: '搜尋員工編號、姓名、職務、資格或服務區域', maxLength: 200 }),
  personFilter: Object.freeze({ key: 'employeeId', selectionKey: 'employee', label: '員工', emptyLabel: '全部可讀員工' }),
  columns: Object.freeze([
    { key: 'employeeNo', label: '員工編號' }, { key: 'name', label: '姓名' },
    { key: 'role', label: '職務' }, { key: 'statusLabel', label: '員工狀態' },
    { key: 'qualification', label: '資格與證照' }, { key: 'regions', label: '服務區域', type: 'employee-regions' },
  ].map(column => Object.freeze(column))),
  rowFields: Object.freeze({
    employeeId: 'string', version: 'positiveInteger', employeeNo: 'string', name: 'string',
    role: 'string', status: 'string', statusLabel: 'string', qualification: 'string', regions: 'employee-regions',
  }),
  validateRow: (row, { filters }) => {
    if (filters.employeeId && row.employeeId !== filters.employeeId) return false;
    if (!filters.q) return true;
    const regions = typeof row.regions === 'string' ? [row.regions] : Array.isArray(row.regions) ? row.regions : [];
    return [row.employeeNo, row.name, row.role, row.qualification, row.statusLabel, ...regions]
      .some(value => value.toLowerCase().includes(filters.q.toLowerCase()));
  },
  validateTotals: result => Object.keys(result.totals).length === 1 && Object.hasOwn(result.totals, 'count'),
  copy: Object.freeze({
    queryTitle: '員工總表查詢', queryButton: '查詢員工',
    help: '查詢目前可讀的員工主檔。關鍵字保留原文字與空白；下載與列印會重新讀取符合條件的完整資料。',
    queryLoading: '正在查詢員工…', tableLoading: '正在讀取員工總表…',
    previewTitle: '員工總表列印預覽', previewLoading: '正在重新讀取完整員工總表…',
    resultLabel: '員工總表查詢結果', completeLabel: '完整員工總表',
    emptyTable: '沒有符合條件的員工，請調整查詢。',
    emptyResult: '沒有符合條件的員工，下載與列印已停用。',
    emptyExport: '目前已無符合條件的員工，請重新查詢。',
    downloadSuccess: '員工總表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 員工${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountEmployeeReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: employeeReportConfig, isCurrent });
}
