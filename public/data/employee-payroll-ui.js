import { assertCalculationSource, canonicalCalculationJson, exactCentsOperation } from './calculation-core.js';
import { LTC_BA_AA_CATALOG } from './ltc-ba-aa-catalog.js';
import { serviceSpan, spanCoveredByDates } from './shift-span.js';
import { EMPLOYEE_PAYROLL_WARNINGS } from './employee-payroll-policy.js';
import { parseBillingMoney } from './billing-document-editor.js';
export { EMPLOYEE_PAYROLL_NOTICE, EMPLOYEE_PAYROLL_WARNINGS } from './employee-payroll-policy.js';

export const profileStatuses = Object.freeze({ draft: '待核定', approved: '機構已核定', inactive: '已停用' });
export const payrollModes = Object.freeze({ hourly: '時薪制', split: '拆帳制' });
export const splitBases = Object.freeze({ 'approved-service-snapshot': '核閱時保存的服務金額', 'collected-receipts': '實際收款金額（介接待核定）' });
export const aaTreatments = Object.freeze({ include: '納入 AA 加計', exclude: '排除 AA 加計', 'not-applicable': '時薪制不適用' });
export const payrollRoundings = Object.freeze({ floor: '無條件捨去至分', ceiling: '無條件進位至分', 'half-up': '四捨五入至分', 'half-even': '同值取偶數至分' });
export const PROFILE_FIELDS = Object.freeze(['employeeId', 'validFrom', 'validTo', 'payrollMode', 'hourlyRateCents', 'shareBasisPoints', 'splitBasis', 'aaTreatment', 'rounding', 'approvalReference', 'note', 'status']);
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const fail = () => { throw new Error('無法確認員工薪資規則或試算結果，請保留輸入並重新讀取。'); };
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const date = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const dense = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(descriptor => descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
export function confirmPayrollEmployee(value, id) {
  if (!closed(value, ['id', 'name', 'employeeNo', 'version']) || !ref(value.id) || id !== undefined && value.id !== id || !text(value.name, 500) || !text(value.employeeNo, 500) || !safe(value.version, 1)) fail();
  return value;
}

export function confirmPayrollProfile(item, { orgId, id, version, expected } = {}) {
  if (!closed(item, [...PROFILE_FIELDS, ...metadata]) || !ref(item.id) || item.orgId !== orgId || !ref(item.orgId) || !ref(item.employeeId)
      || !safe(item.version, 1) || id && item.id !== id || version !== undefined && item.version !== version
      || !iso(item.createdAt) || !iso(item.updatedAt) || item.updatedAt < item.createdAt || !date(item.validFrom) || !date(item.validTo) || item.validTo < item.validFrom
      || !Object.hasOwn(profileStatuses, item.status) || !Object.hasOwn(payrollModes, item.payrollMode) || !Object.hasOwn(payrollRoundings, item.rounding)
      || !text(item.approvalReference, 2000) || !text(item.note, 10000) || item.status === 'approved' && (!item.approvalReference.trim() || item.approvalReference !== item.approvalReference.trim() || /[\u0000-\u001f\u007f]/.test(item.approvalReference))) fail();
  if (item.payrollMode === 'hourly' ? !safe(item.hourlyRateCents, 1, 1000000000) || item.shareBasisPoints !== null || item.splitBasis !== null || item.aaTreatment !== 'not-applicable'
    : item.hourlyRateCents !== null || !safe(item.shareBasisPoints, 1, 10000) || !Object.hasOwn(splitBases, item.splitBasis) || !['include', 'exclude'].includes(item.aaTreatment)) fail();
  for (const [key, value] of Object.entries(expected || {})) if (!PROFILE_FIELDS.includes(key) || item[key] !== value) fail();
  return item;
}
export function confirmPayrollAck(result, request) {
  if (!closed(result, ['item'])) fail();
  return confirmPayrollProfile(result.item, request);
}
export function confirmPayrollList(result, { orgId, page, pageSize = 25 }) {
  if (!closed(result, ['orgId', 'items', 'total', 'page', 'pageSize', 'employeeSnapshots']) || result.orgId !== orgId || !dense(result.items) || !dense(result.employeeSnapshots) || !safe(result.total) || result.page !== page || result.pageSize !== pageSize
      || result.items.length !== Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize))) fail();
  const seen = new Set(), employees = new Set(); for (const item of result.items) { confirmPayrollProfile(item, { orgId }); if (seen.has(item.id)) fail(); seen.add(item.id); employees.add(item.employeeId); }
  const projections = new Set(); for (const employee of result.employeeSnapshots) { confirmPayrollEmployee(employee); if (!employees.has(employee.id) || projections.has(employee.id)) fail(); projections.add(employee.id); }
  if (projections.size !== employees.size) fail();
  return result;
}
export function confirmPayrollHistory(result, { orgId, id }) {
  if (!closed(result, ['orgId', 'id', 'items', 'total']) || result.orgId !== orgId || result.id !== id || !dense(result.items) || !safe(result.total, 1) || result.items.length !== result.total) fail();
  const sources = ['employee-payroll.create', 'employee-payroll.update', 'employee-payroll.approve', 'employee-payroll.inactivate'];
  result.items.forEach((entry, index) => {
    if (!closed(entry, ['version', 'source', 'createdAt', 'snapshot']) || entry.version !== result.total - index || !sources.includes(entry.source) || !iso(entry.createdAt)) fail();
    const item = confirmPayrollProfile(entry.snapshot, { orgId, id, version: entry.version }); if (item.updatedAt !== entry.createdAt) fail();
  });
  let previous;
  for (const entry of [...result.items].reverse()) {
    const item = entry.snapshot;
    if (!previous ? item.status !== 'draft' || entry.source !== 'employee-payroll.create' || item.createdAt !== item.updatedAt
      : item.employeeId !== previous.employeeId || item.createdAt !== previous.createdAt || item.updatedAt < previous.updatedAt || previous.status === 'inactive'
        || entry.source !== (item.status === 'approved' ? 'employee-payroll.approve' : item.status === 'inactive' ? 'employee-payroll.inactivate' : 'employee-payroll.update')
        || previous.status === 'approved' && (item.status !== 'inactive' || PROFILE_FIELDS.filter(key => key !== 'status').some(key => item[key] !== previous[key]))) fail();
    previous = item;
  } return result;
}
export function confirmPayrollCandidates(result, query) {
  if (!closed(result, ['orgId', 'employeeId', 'month', 'items', 'total', 'page', 'pageSize']) || !dense(result.items) || result.orgId !== query.orgId || result.employeeId !== query.employeeId
      || result.month !== query.month || result.page !== query.page || result.pageSize !== 25 || !safe(result.total)
      || result.items.length !== Math.min(25, Math.max(0, result.total - (query.page - 1) * 25))) fail();
  const seen = new Set(); for (const item of result.items) {
    if (!closed(item, ['id', 'orgId', 'employeeId', 'version', 'date', 'serviceMinutes', 'label']) || !ref(item.id) || item.orgId !== query.orgId || item.employeeId !== query.employeeId
        || !safe(item.version, 1) || !date(item.date) || !item.date.startsWith(query.month + '-') || !safe(item.serviceMinutes, 1, 2879) || !text(item.label, 100200) || seen.has(item.id)) fail();
    seen.add(item.id);
  } return result;
}
export function buildPayrollProfile(values, status = 'draft', original = null) {
  const savedText = key => {
    const submitted = Object.getOwnPropertyDescriptor(values, key);
    if (!submitted || !Object.hasOwn(submitted, 'value') || typeof submitted.value !== 'string') fail();
    if (original !== null) {
      const saved = Object.getOwnPropertyDescriptor(original, key);
      if (!saved || !Object.hasOwn(saved, 'value') || typeof saved.value !== 'string') fail();
      // Native textarea normalizes CRLF/lone CR to LF. An unchanged display
      // keeps the complete saved text, including its original whitespace.
      if (submitted.value === saved.value.replace(/\r\n?/g, '\n')) return saved.value;
    }
    return key === 'approvalReference' ? submitted.value.trim() : submitted.value;
  };
  const amount = (value, key, max, percent = false) => {
    try { return parseBillingMoney(value, { key, minCents: 1, maxCents: max }); }
    catch (cause) { if (!percent) throw cause; const error = new Error('拆帳比例須介於 0.01% 至 100%，最多兩位小數。'); error.fields = { [key]: error.message }; throw error; }
  };
  return { employeeId: values.employeeId, validFrom: values.validFrom, validTo: values.validTo, payrollMode: values.payrollMode,
    hourlyRateCents: values.payrollMode === 'hourly' ? amount(values.hourlyRateCents, 'hourlyRateCents', 1000000000) : null,
    shareBasisPoints: values.payrollMode === 'split' ? amount(values.shareBasisPoints, 'shareBasisPoints', 10000, true) : null,
    splitBasis: values.payrollMode === 'split' ? values.splitBasis : null, aaTreatment: values.payrollMode === 'split' ? values.aaTreatment : 'not-applicable',
    rounding: values.rounding, approvalReference: savedText('approvalReference'), note: savedText('note'), status };
}
export async function confirmEmployeePayrollPreview(result, payload, orgId, expectedProfile) {
  if (!closed(result, ['mode', 'previewOnly', 'orgId', 'month', 'employeeSnapshot', 'profileSnapshot', 'sourceSnapshots', 'lines', 'totalAmountCents', 'currency', 'warnings', 'previewHash'])
      || result.mode !== 'employee-payroll-preview-v1' || result.previewOnly !== true || result.orgId !== orgId || result.month !== payload.month || result.currency !== 'TWD'
      || !safe(result.totalAmountCents) || !dense(result.sourceSnapshots) || !dense(result.lines) || result.sourceSnapshots.length !== payload.sources.length || result.lines.length !== payload.sources.length
      || !dense(result.warnings) || result.warnings.length !== EMPLOYEE_PAYROLL_WARNINGS.length || result.warnings.some((value, index) => value !== EMPLOYEE_PAYROLL_WARNINGS[index]) || typeof result.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(result.previewHash)) fail();
  const profile = confirmPayrollProfile(result.profileSnapshot, { orgId, id: payload.profile.id, version: payload.profile.version });
  if (expectedProfile && canonicalCalculationJson(profile) !== canonicalCalculationJson(confirmPayrollProfile(expectedProfile, { orgId, id: payload.profile.id, version: payload.profile.version }))) fail();
  if (profile.status !== 'approved' || profile.splitBasis === 'collected-receipts' || !closed(result.employeeSnapshot, ['id', 'name', 'employeeNo', 'version']) || result.employeeSnapshot.id !== profile.employeeId
      || !text(result.employeeSnapshot.name, 500) || !text(result.employeeSnapshot.employeeNo, 500) || !safe(result.employeeSnapshot.version, 1)) fail();
  let total = 0n; const seen = new Set();
  result.sourceSnapshots.forEach((source, index) => {
    assertCalculationSource(source); const request = payload.sources[index], line = result.lines[index];
    if (source.orgId !== orgId || source.id !== request.id || source.version !== request.version || source.employeeId !== profile.employeeId || !source.date.startsWith(payload.month + '-')
        || seen.has(source.id)
        || !closed(line, ['serviceRecordId', 'version', 'date', 'serviceMinutes', 'basisCents', 'amountCents', 'trace']) || line.serviceRecordId !== source.id || line.version !== source.version
        || line.date !== source.date || line.serviceMinutes !== source.billingSnapshot.serviceMinutes || !safe(line.amountCents)) fail();
    seen.add(source.id);
    if (!spanCoveredByDates(serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(Object.hasOwn(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) }), profile.validFrom, profile.validTo)) fail();
    let basis = null, trace;
    if (profile.payrollMode === 'hourly') trace = exactCentsOperation({ operation: 'minutes-hourly', minutes: line.serviceMinutes, hourlyRateCents: profile.hourlyRateCents, rounding: profile.rounding });
    else {
      if (source.billingSnapshot.items.some(item => !LTC_BA_AA_CATALOG.items.some(code => code.code === item.code))) fail();
      const integer = source.billingSnapshot.items.filter(item => profile.aaTreatment === 'include' || item.code.startsWith('BA')).reduce((sum, item) => sum + BigInt(item.amountCents), 0n);
      if (integer > BigInt(Number.MAX_SAFE_INTEGER)) fail(); basis = Number(integer);
      trace = exactCentsOperation({ operation: 'basis-points', amountCents: basis, basisPoints: profile.shareBasisPoints, rounding: profile.rounding });
    }
    if (line.basisCents !== basis || line.amountCents !== trace.resultCents || canonicalCalculationJson(line.trace) !== canonicalCalculationJson(trace)) fail(); total += BigInt(line.amountCents);
  });
  if (total !== BigInt(result.totalAmountCents)) fail();
  const { previewHash, ...body } = result, digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalCalculationJson(body)));
  if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== previewHash) fail(); return result;
}
