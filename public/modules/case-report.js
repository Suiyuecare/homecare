import { mountReportView } from './report-view.js';

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const taipei = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });

// Reject calendar normalization before converting the stored timestamp to Taipei.
// Preserve its original text for the report; the conversion only confirms createdDate.
function savedTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || (match[5] !== 'Z' && (Number(match[6]) > 23 || Number(match[7]) > 59))) return NaN;
  return Date.parse(value);
}

export const caseReportConfig = Object.freeze({
  key: 'case-report', path: '/api/case-report', title: '個案總表', idKey: 'caseId', statusLabel: '個案狀態',
  statuses: Object.freeze({ active: '服務中', paused: '暫停', closed: '結案' }),
  personFilter: Object.freeze({
    key: 'supervisorId', selectionKey: 'supervisor', label: '主責督導', emptyLabel: '全部可讀主責督導',
    options: (cases, employees) => {
      const assigned = new Set(cases.map(item => item.supervisorId).filter(Boolean));
      return employees.filter(item => assigned.has(item.id));
    },
  }),
  date: Object.freeze({ rowKey: 'createdDate', startLabel: '建立日期起', endLabel: '建立日期迄', rangeLabel: '系統建立日期範圍（臺北）' }),
  columns: Object.freeze([
    ['createdDate', '系統建立日期（臺北）'], ['caseNo', '案號'], ['name', '個案'], ['gender', '性別'],
    ['cmsLevel', 'CMS 等級'], ['welfare', '福利身分別'], ['statusLabel', '個案狀態'],
    ['supervisorNo', '督導編號'], ['supervisor', '主責督導'], ['version', '版次'],
    ['updatedAt', '系統更新時間'], ['note', '個案備註'],
  ].map(([key, label]) => Object.freeze({ key, label }))),
  rowFields: Object.freeze({
    caseId: 'string', version: 'positiveInteger', createdDate: 'string', caseNo: 'string', name: 'string',
    gender: 'string', cmsLevel: 'string', welfare: 'string', status: 'string', statusLabel: 'string',
    supervisorNo: 'string', supervisor: 'string', createdAt: 'string', updatedAt: 'string', note: 'string',
  }),
  validateRow: row => {
    const created = savedTimestamp(row.createdAt), updated = savedTimestamp(row.updatedAt);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
    const parts = Object.fromEntries(taipei.formatToParts(created).map(part => [part.type, part.value]));
    const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
    const day = `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`;
    return validDate(day) && row.createdDate === day;
  },
  copy: Object.freeze({
    queryTitle: '個案總表查詢', queryButton: '查詢個案',
    help: '依臺北時區的系統建立日期查詢，並非收案日；期間最多 366 日。下載與列印會重新讀取目前可讀個案。',
    queryLoading: '正在查詢個案…', tableLoading: '正在讀取個案總表…',
    previewTitle: '個案總表列印預覽', previewLoading: '正在重新讀取完整個案總表…',
    resultLabel: '個案總表查詢結果', completeLabel: '完整個案總表',
    emptyTable: '沒有符合條件的個案，請調整查詢。',
    emptyResult: '沒有符合條件的個案，下載與列印已停用。',
    emptyExport: '目前已無符合條件的個案，請重新查詢。',
    downloadSuccess: '個案總表 CSV 下載已開始。',
  }),
  summary: (result, { complete }) => `符合條件共 ${result.total} 個案${complete ? '；以下為完整資料。' : `；本頁 ${result.rows.length} 筆。`}`,
});

export function mountCaseReport(container, { isCurrent = () => true } = {}) {
  return mountReportView(container, { config: caseReportConfig, isCurrent });
}
