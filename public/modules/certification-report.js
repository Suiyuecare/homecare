import { mountReportView } from './report-view.js';

const expiryLabels = Object.freeze({ expired: '已到期', due_soon: '即將到期', valid: '有效期內', no_expiry: '未填到期日', revoked: '已撤銷' });
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Response confirmation only: matches the existing personnel reminder, never writes a qualification.
function matchesExpiry(row, asOf) {
  if (!validDate(row.issuedOn) || !validDate(asOf) || (row.expiresOn !== '' && (!validDate(row.expiresOn) || row.expiresOn < row.issuedOn))) return false;
  const days = row.expiresOn ? Math.round((Date.parse(`${row.expiresOn}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000) : null;
  const state = row.status === 'revoked' ? 'revoked' : days === null ? 'no_expiry' : days < 0 ? 'expired' : days <= 30 ? 'due_soon' : 'valid';
  return row.expiryState === state && row.expiryLabel === expiryLabels[state];
}

export const certificationReportConfig = Object.freeze({
  key: 'certification-report', path: '/api/certification-report', title: '員工證照紀錄總表', idKey: 'certificationId', statusLabel: '紀錄狀態',
  statuses: Object.freeze({ active: '有效紀錄', revoked: '已撤銷' }),
  date: Object.freeze({ rowKey: 'issuedOn', displayRowKeys: Object.freeze(['expiresOn']), startLabel: '核發日期起', endLabel: '核發日期迄', rangeLabel: '核發日期範圍' }),
  asOf: Object.freeze({ label: '效期截至日期' }),
  expiry: Object.freeze({ label: '效期狀態', selectionKey: 'expiry', emptyLabel: '全部效期', labels: expiryLabels }),
  caseFilter: false,
  search: Object.freeze({ key: 'q', label: '關鍵字', placeholder: '搜尋員工編號、姓名、證照、證號、發證單位或備註', maxLength: 200 }),
  personFilter: Object.freeze({ key: 'employeeId', selectionKey: 'employee', label: '員工', emptyLabel: '全部可讀員工' }),
  columns: Object.freeze([
    ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'], ['name', '證照名稱'], ['certificateNo', '證號'],
    ['issuer', '發證單位'], ['issuedOn', '核發日期'], ['expiresOn', '到期日期'], ['statusLabel', '紀錄狀態'],
    ['expiryLabel', '效期狀態'], ['note', '證照備註'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    certificationId: 'string', version: 'positiveInteger', employeeId: 'string', employeeNo: 'string', employee: 'string', name: 'string',
    certificateNo: 'string', issuer: 'string', issuedOn: 'string', expiresOn: 'string', status: 'string', statusLabel: 'string',
    expiryState: 'string', expiryLabel: 'string', note: 'string',
  }),
  validateRow: (row, { filters }) => {
    if ((filters.employeeId && row.employeeId !== filters.employeeId) || !matchesExpiry(row, filters.asOf) || (filters.expiry && row.expiryState !== filters.expiry)) return false;
    return !filters.q || [row.employeeNo, row.employee, row.name, row.certificateNo, row.issuer, row.note, row.statusLabel]
      .some(value => value.toLowerCase().includes(filters.q.toLowerCase()));
  },
  validateTotals: result => Object.keys(result.totals).length === 1 && Object.hasOwn(result.totals, 'count'),
  copy: Object.freeze({
    queryTitle: '員工證照紀錄總表查詢', queryButton: '查詢證照',
    help: '依保存核發日期查詢，期間最多 366 日；效期依截至日期提醒，合計僅筆數。下載與列印重新讀取完整紀錄，不作生效、法定資格或薪資認定。',
    queryLoading: '正在查詢證照紀錄…', tableLoading: '正在讀取員工證照紀錄總表…',
    previewTitle: '員工證照紀錄總表列印預覽', previewLoading: '正在重新讀取完整證照紀錄…',
    resultLabel: '員工證照紀錄總表查詢結果', completeLabel: '完整員工證照紀錄總表',
    emptyTable: '沒有符合條件的證照紀錄，請調整查詢。', emptyResult: '沒有符合條件的證照紀錄，下載與列印已停用。',
    emptyExport: '目前已無符合條件的證照紀錄，請重新查詢。', downloadSuccess: '員工證照紀錄總表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 筆證照紀錄${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountCertificationReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: certificationReportConfig, isCurrent });
}
