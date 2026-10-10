import { dateValid, fail, scopedRows } from './model.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit } from './report-query.mjs';

const statusLabels = Object.freeze({ active: '服務中', paused: '暫停', closed: '結案' });
const columns = [
  ['createdDate', '系統建立日期（臺北）'], ['caseNo', '案號'], ['name', '個案'],
  ['gender', '性別'], ['cmsLevel', 'CMS 等級'], ['welfare', '福利身分別'],
  ['statusLabel', '個案狀態'], ['supervisorNo', '督導編號'], ['supervisor', '主責督導'],
  ['version', '版次'], ['updatedAt', '系統更新時間'], ['note', '個案備註'],
].map(([key, label]) => Object.freeze({ key, label }));
const text = value => typeof value === 'string' ? value : '';
const display = (value, fallback) => text(value) || fallback;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const taipei = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });
const invalid = () => fail(409, 'REPORT_DATA_INVALID', '符合查詢範圍的個案包含無效系統時間或版次，請先核對資料；本次未輸出報表。');

/** Validate the saved calendar components before Date.parse can normalize them. */
function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !dateValid(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || (match[5] !== 'Z' && (Number(match[6]) > 23 || Number(match[7]) > 59))) invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  return milliseconds;
}

function createdDate(value) {
  const parts = Object.fromEntries(taipei.formatToParts(timestamp(value)).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const date = String(year).padStart(4, '0') + '-' + parts.month + '-' + parts.day;
  if (!dateValid(date)) invalid();
  return date;
}

/** Current authorized case masters, with no contact/clinical/financial inference. */
export function readCaseReport(db, ctx, params, { full = false } = {}) {
  const { filters, page, pageSize } = parseReportQuery(params, { full, statusLabels, statusMessage: '不支援的個案狀態', personKey: 'supervisorId' });
  const cases = new Map(scopedRows(db, ctx, 'cases').map(item => [item.id, item]));
  const assigned = new Set([...cases.values()].map(item => item.supervisorId).filter(Boolean));
  const supervisors = new Map(scopedRows(db, ctx, 'employees').filter(item => assigned.has(item.id)).map(item => [item.id, item]));
  validateReportReferences(filters, cases, supervisors, { referenceKey: 'supervisorId' });
  const candidates = [...cases.values()].filter(item =>
    (!filters.caseId || item.id === filters.caseId) &&
    (!filters.supervisorId || item.supervisorId === filters.supervisorId) &&
    (!filters.status || item.status === filters.status));
  const projected = [];
  for (const item of candidates) {
    const day = createdDate(item.createdAt);
    if (day < filters.startDate || day > filters.endDate) continue;
    timestamp(item.updatedAt);
    if (!Number.isSafeInteger(item.version) || item.version < 1) invalid();
    const supervisor = supervisors.get(item.supervisorId);
    projected.push({
      caseId: item.id, version: item.version, createdDate: day, caseNo: text(item.caseNo), name: text(item.name),
      gender: text(item.gender), cmsLevel: typeof item.cmsLevel === 'number' ? String(item.cmsLevel) : text(item.cmsLevel),
      welfare: text(item.welfare), status: text(item.status), statusLabel: statusLabels[item.status] || '未取得狀態',
      supervisorNo: text(supervisor?.employeeNo), supervisor: !item.supervisorId ? '尚未指定' : display(supervisor?.name, '主責督導名稱未取得'),
      createdAt: item.createdAt, updatedAt: item.updatedAt, note: text(item.note),
    });
  }
  if (full) assertReportExportLimit(projected.length);
  projected.sort((a, b) => {
    for (const key of ['createdDate', 'caseNo', 'caseId']) {
      const result = compareText(a[key], b[key]);
      if (result) return result;
    }
    return 0;
  });
  const total = projected.length;
  const organization = db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId);
  const result = {
    title: '個案總表', organization: { name: organization?.name || '未取得機構名稱' }, filters,
    selection: {
      case: filters.caseId ? display(cases.get(filters.caseId)?.name, '未取得個案名稱') : '全部可讀個案',
      supervisor: filters.supervisorId ? display(supervisors.get(filters.supervisorId)?.name, '主責督導名稱未取得') : '全部可讀主責督導',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機測試報表；個案與主責督導使用目前主檔，非歷史姓名。系統建立日期依臺北時區換算，並非收案日；系統更新時間保留保存的時區文字，並非狀態變更日。CMS與福利身分僅呈現保存值，不計分或推定資格；正式表單欄位與版面尚未核對。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
