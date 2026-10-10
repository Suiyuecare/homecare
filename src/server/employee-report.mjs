import { fail, scopedRows } from './model.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit, safeVersionReader } from './report-query.mjs';
import { normalizeEmployeeRegions } from '../../public/data/employee-regions.js';

const statusLabels = Object.freeze({ active: '啟用', inactive: '停用' });
const columns = [
  { key: 'employeeNo', label: '員工編號' },
  { key: 'name', label: '姓名' },
  { key: 'role', label: '職務' },
  { key: 'statusLabel', label: '員工狀態' },
  { key: 'qualification', label: '資格與證照' },
  { key: 'regions', label: '服務區域', type: 'employee-regions' },
];
const text = value => typeof value === 'string' ? value : '';
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function matchesSearch(employee, query) {
  if (!query) return true;
  const regions = normalizeEmployeeRegions(employee.regions);
  const fields = [employee.employeeNo, employee.name, employee.role, employee.qualification,
    statusLabels[employee.status], ...(typeof regions === 'string' ? [regions] : Array.isArray(regions) ? regions : [])];
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(query));
}

export function readEmployeeReport(db, ctx, params, { full = false } = {}) {
  const { filters, page, pageSize } = parseReportQuery(params, {
    full, statusLabels, statusMessage: '不支援的員工狀態', date: false, caseFilter: false, search: true,
  });
  const employees = new Map(scopedRows(safeVersionReader(db), ctx, 'employees').map(employee => [employee.id, employee]));
  validateReportReferences(filters, new Map(), employees);
  const query = filters.q.toLowerCase();
  const candidates = [...employees.values()].filter(employee =>
    (!filters.employeeId || employee.id === filters.employeeId) &&
    (!filters.status || employee.status === filters.status) && matchesSearch(employee, query));
  for (const employee of candidates) {
    if (typeof employee.id !== 'string' || !employee.id || !Number.isSafeInteger(employee.version) || employee.version < 1 ||
        !Object.hasOwn(statusLabels, employee.status)) {
      fail(409, 'REPORT_DATA_INVALID', '符合條件的員工資料含無法判讀的識別碼、版次或狀態，請先確認原紀錄');
    }
  }
  if (full) assertReportExportLimit(candidates.length);
  const projected = candidates.map(employee => ({
    employeeId: employee.id, version: employee.version, employeeNo: text(employee.employeeNo),
    name: text(employee.name), role: text(employee.role), status: employee.status,
    statusLabel: statusLabels[employee.status], qualification: text(employee.qualification),
    regions: normalizeEmployeeRegions(employee.regions),
  })).sort((a, b) => compareText(a.employeeNo, b.employeeNo) || compareText(a.name, b.name) || compareText(a.employeeId, b.employeeId));
  const total = projected.length;
  const selectedName = filters.employeeId ? text(employees.get(filters.employeeId)?.name) : '';
  const result = {
    title: '員工總表',
    organization: { name: db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId)?.name || '' },
    filters,
    selection: {
      employee: filters.employeeId ? selectedName.trim() ? selectedName : '名稱未取得' : '全部可讀員工',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機目前員工主檔；職務文字不代表登入權限，資格摘要不認定法定合格或積分，服務區域保留保存型別、順序及空項。不是薪資、出勤或正式表單。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
