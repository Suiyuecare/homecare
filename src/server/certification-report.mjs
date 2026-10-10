import { dateValid, fail, scopedRows } from './model.mjs';
import { guardPersonnelAccess, certificationView } from './personnel.mjs';
import { parseReportQuery, validateReportReferences, assertReportExportLimit, safeVersionReader } from './report-query.mjs';

const statusLabels = Object.freeze({ active: '有效紀錄', revoked: '已撤銷' });
const expiryLabels = Object.freeze({ expired: '已到期', due_soon: '即將到期', valid: '有效期內', no_expiry: '未填到期日', revoked: '已撤銷' });
const columns = [
  ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'], ['name', '證照名稱'],
  ['certificateNo', '證號'], ['issuer', '發證單位'], ['issuedOn', '核發日期'],
  ['expiresOn', '到期日期'], ['statusLabel', '紀錄狀態'], ['expiryLabel', '效期狀態'], ['note', '證照備註'],
].map(([key, label]) => Object.freeze({ key, label }));
const text = value => typeof value === 'string' ? value : '';
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const statusLabel = value => typeof value === 'string' && Object.hasOwn(statusLabels, value) ? statusLabels[value] : '';
const invalid = () => fail(409, 'REPORT_DATA_INVALID', '符合條件的證照紀錄含無法判讀的核發日期、到期日期、識別碼、版次或狀態，請先確認原紀錄');

function matchesSearch(certification, employee, query) {
  if (!query) return true;
  return [employee?.employeeNo, employee?.name, certification.name, certification.certificateNo,
    certification.issuer, certification.note, statusLabel(certification.status)]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
}

/** Keep saved personnel scope; employee lookups and expiry reminders do not determine qualifications. */
export function readCertificationReport(db, ctx, params, { full = false } = {}) {
  guardPersonnelAccess('employee-certifications', ctx, true, fail);
  const { filters, page, pageSize } = parseReportQuery(params, {
    full, statusLabels, statusMessage: '不支援的證照紀錄狀態', caseFilter: false, search: true, asOf: true, expiryLabels,
  });
  const reader = safeVersionReader(db);
  const employees = new Map(scopedRows(reader, ctx, 'employees').map(employee => [employee.id, employee]));
  validateReportReferences(filters, new Map(), employees);
  const query = filters.q.toLowerCase();
  const candidates = scopedRows(reader, ctx, 'employee-certifications').filter(certification =>
    (!filters.employeeId || certification.employeeId === filters.employeeId) &&
    (!filters.status || certification.status === filters.status) && matchesSearch(certification, employees.get(certification.employeeId), query));
  for (const certification of candidates) if (!dateValid(certification.issuedOn)) invalid();
  const matching = candidates.filter(certification => certification.issuedOn >= filters.startDate && certification.issuedOn <= filters.endDate);
  const projected = matching.map(certification => {
    if (typeof certification.id !== 'string' || !certification.id || !Number.isSafeInteger(certification.version) || certification.version < 1 ||
        !statusLabel(certification.status) || (certification.expiresOn !== undefined && certification.expiresOn !== '' &&
          (!dateValid(certification.expiresOn) || certification.expiresOn < certification.issuedOn))) invalid();
    const { expiryState } = certificationView(certification, filters.asOf), employee = employees.get(certification.employeeId);
    return {
      certificationId: certification.id, version: certification.version, employeeId: text(certification.employeeId),
      employeeNo: text(employee?.employeeNo), employee: text(employee?.name), name: text(certification.name),
      certificateNo: text(certification.certificateNo), issuer: text(certification.issuer), issuedOn: certification.issuedOn,
      expiresOn: text(certification.expiresOn), status: certification.status, statusLabel: statusLabels[certification.status],
      expiryState, expiryLabel: expiryLabels[expiryState], note: text(certification.note),
    };
  }).filter(certification => !filters.expiry || certification.expiryState === filters.expiry);
  if (full) assertReportExportLimit(projected.length);
  projected.sort((a, b) => compareText(a.issuedOn, b.issuedOn) || compareText(a.employeeNo, b.employeeNo) ||
    compareText(a.name, b.name) || compareText(a.certificationId, b.certificationId));
  const total = projected.length;
  const selectedName = filters.employeeId ? text(employees.get(filters.employeeId)?.name) : '';
  const result = {
    title: '員工證照紀錄總表',
    organization: { name: db.prepare('SELECT name FROM organizations WHERE id=?').get(ctx.orgId)?.name || '' },
    filters,
    selection: {
      employee: filters.employeeId ? selectedName.trim() ? selectedName : '名稱未取得' : '全部可讀員工',
      status: filters.status ? statusLabels[filters.status] : '全部狀態',
      expiry: filters.expiry ? expiryLabels[filters.expiry] : '全部效期',
    },
    generatedAt: new Date().toISOString(), columns,
    rows: full ? projected : projected.slice((page - 1) * pageSize, page * pageSize),
    totals: { count: total }, total, page: full ? 1 : page, pageSize: full ? total : pageSize,
    note: '本機保存證照紀錄，使用目前可讀員工名稱；名稱缺失以「—」呈現。依保存核發日期查詢，效期狀態依指定截至日期提供提醒；不判定核發日是否已生效、正式資格或排班資格，尚未核定正式表單規則。',
  };
  if (full) assertReportExportLimit(total, result);
  return result;
}
