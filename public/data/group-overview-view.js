export const GROUP_OVERVIEW_MODE = 'authorized-organization-start-date-counts-v1';
export const GROUP_OVERVIEW_NOTICE = '各機構目前保存紀錄的筆數；依開始日歸屬，跨機構同一人會各計一次，不代表去重人數、收入、工時或正式申報。';
export const GROUP_METRICS = Object.freeze([
  { key: 'caseTotal', label: '個案紀錄', help: '目前保存的個案紀錄筆數' },
  { key: 'activeCases', label: '服務中個案', help: '目前狀態為服務中的紀錄' },
  { key: 'employeeTotal', label: '員工紀錄', help: '目前保存的員工紀錄筆數' },
  { key: 'activeEmployees', label: '使用中員工', help: '目前狀態為使用中的紀錄' },
  { key: 'startsShifts', label: '當日開始班次', help: '基準日開始，排除取消的班次' },
  { key: 'completedStartShifts', label: '其中已完成', help: '基準日開始且已完成的班次' },
  { key: 'submittedRecords', label: '目前待核閱', help: '所有目前待核閱紀錄，不限定日期' },
  { key: 'approvedMonthRecords', label: '基準月已核閱', help: '服務開始日屬基準月份的已核閱紀錄' },
]);
const metricKeys = GROUP_METRICS.map(item => item.key);
const statuses = { caseTotal: ['active', 'paused', 'closed'], activeCases: ['active'], employeeTotal: ['active', 'inactive'], activeEmployees: ['active'], startsShifts: ['scheduled', 'completed'], completedStartShifts: ['completed'], submittedRecords: ['submitted'], approvedMonthRecords: ['approved'] };
const field = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && field(value, key)?.enumerable && Object.hasOwn(field(value, key), 'value'));
const closed = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = (value, min, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => String(i)).every(key => field(value, key)?.enumerable && Object.hasOwn(field(value, key), 'value'));
const text = (value, max = 500, required = false) => typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()));
const ref = value => text(value, 500, true) && value === value.trim() && !/[\0\r\n]/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
export const isGroupDate = (value, allowYearZero = false) => typeof allowYearZero === 'boolean' && typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value) && (allowYearZero || !value.startsWith('0000')) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const iso = value => typeof value === 'string' && value.length === 24 && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fingerprint = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const bad = () => { throw new Error('群組總覽回應未確認，請重新查詢目前授權與完整資料。'); };
const copy = value => JSON.parse(JSON.stringify(value));
export const groupOverviewIdentity = context => JSON.stringify([context?.user?.id, context?.organizationId ?? context?.orgId, context?.role, context?.user?.role, context?.user?.employeeId, context?.employeeId]);
export function groupOverviewRequest(value) {
  if (!closed(value, ['orgIds', 'date']) || !dense(value.orgIds, 1, 10) || value.orgIds.some(id => !ref(id)) || new Set(value.orgIds).size !== value.orgIds.length || !isGroupDate(value.date)) {
    const error = new Error('請明確選取 1 至 10 個授權機構及有效基準日。');
    error.fields = { orgIds: '請選取 1 至 10 個不同的管理者機構。', date: '請填寫 0001 至 9999 年的有效基準日。' }; throw error;
  }
  return copy(value);
}
export function groupOverviewPath(request, csv = false) {
  if (typeof csv !== 'boolean') bad(); const value = groupOverviewRequest(request);
  return '/api/group-overview' + (csv ? '.csv' : '') + '?' + new URLSearchParams([...value.orgIds.map(id => ['organizationId', id]), ['date', value.date]]);
}
/** Existing /api/session is read only. Only currently authorized admin choices are returned to this UI. */
export function confirmGroupDirectory(session, expected) {
  if (!closed(expected, ['userId', 'orgId']) || !ref(expected.userId) || !ref(expected.orgId) || !plain(session) || !closed(session, Object.hasOwn(session, 'authMode') ? ['user', 'organizations', 'csrfToken', 'authMode'] : ['user', 'organizations', 'csrfToken']) || (Object.hasOwn(session, 'authMode') && session.authMode !== 'portal') || !closed(session.user, ['id', 'name', 'email', 'role', 'employeeId']) || session.user.id !== expected.userId || !text(session.user.name, 500, true) || !text(session.user.email, 254, true) || session.user.role !== 'admin' || (session.user.employeeId !== null && !ref(session.user.employeeId)) || typeof session.csrfToken !== 'string' || session.csrfToken.length !== 64 || !/^[a-f0-9]+$/.test(session.csrfToken) || !dense(session.organizations, 1, Number.MAX_SAFE_INTEGER)) bad();
  const ids = new Set();
  for (const org of session.organizations) {
    if (!closed(org, ['id', 'name', 'role', 'employeeId']) || !ref(org.id) || ids.has(org.id) || !text(org.name, 500, true) || !['admin', 'supervisor', 'caregiver', 'finance'].includes(org.role) || (org.employeeId !== null && !ref(org.employeeId))) bad(); ids.add(org.id);
  }
  if (!session.organizations.some(org => org.id === expected.orgId && org.role === 'admin')) bad();
  return session.organizations.filter(org => org.role === 'admin').map(org => ({ id: org.id, name: org.name }));
}
function counts(value, max = 50000) {
  if (!closed(value, metricKeys) || metricKeys.some(key => !integer(value[key], 0, max)) || value.activeCases > value.caseTotal || value.activeEmployees > value.employeeTotal || value.completedStartShifts > value.startsShifts) bad();
}
export function groupOverviewDays(date) { if (!isGroupDate(date)) bad(); return Array.from({ length: 7 }, (_, index) => new Date(Date.parse(date + 'T00:00:00Z') - (6 - index) * 86400000).toISOString().slice(0, 10)); }
export function confirmGroupOverview(output, expected) {
  const request = groupOverviewRequest(expected), dates = groupOverviewDays(request.date);
  if (!closed(output, ['mode', 'date', 'organizations', 'totals', 'notice', 'capturedAt']) || output.mode !== GROUP_OVERVIEW_MODE || output.date !== request.date || output.notice !== GROUP_OVERVIEW_NOTICE || !iso(output.capturedAt) || !dense(output.organizations, request.orgIds.length, request.orgIds.length)) bad();
  for (const [index, org] of output.organizations.entries()) {
    if (!closed(org, ['id', 'name', 'counts', 'trend', 'fingerprint']) || org.id !== request.orgIds[index] || !text(org.name, 500, true) || !fingerprint(org.fingerprint) || !dense(org.trend, 7, 7)) bad(); counts(org.counts);
    for (const [dayIndex, day] of org.trend.entries()) if (!closed(day, ['date', 'startsShifts', 'completedStartShifts', 'approvedRecords']) || !isGroupDate(day.date, true) || day.date !== dates[dayIndex] || !integer(day.startsShifts, 0, 50000) || !integer(day.completedStartShifts, 0, day.startsShifts) || !integer(day.approvedRecords, 0, 50000)) bad();
    if (org.trend.at(-1).startsShifts !== org.counts.startsShifts || org.trend.at(-1).completedStartShifts !== org.counts.completedStartShifts) bad();
  }
  counts(output.totals, 500000); for (const key of metricKeys) if (BigInt(output.totals[key]) !== output.organizations.reduce((sum, org) => sum + BigInt(org.counts[key]), 0n)) bad(); return copy(output);
}
export function groupOverviewDrillRequest(overview, orgId, metric, page = 1) {
  if (!ref(orgId) || !metricKeys.includes(metric) || !integer(page, 1) || !plain(overview) || !dense(overview.organizations, 1, 10)) bad();
  const checked = confirmGroupOverview(overview, { orgIds: overview.organizations.map(org => { if (!plain(org)) bad(); return org.id; }), date: overview.date }), org = checked.organizations.find(item => item.id === orgId); if (!org) bad();
  return { orgIds: [orgId], date: checked.date, metric, fingerprint: org.fingerprint, page };
}
function drillRequest(request) {
  if (!closed(request, ['orgIds', 'date', 'metric', 'fingerprint', 'page']) || !dense(request.orgIds, 1, 1) || !ref(request.orgIds[0]) || !isGroupDate(request.date) || !metricKeys.includes(request.metric) || !fingerprint(request.fingerprint) || !integer(request.page, 1)) bad(); return copy(request);
}
export function groupOverviewRecordsPath(request) {
  const value = drillRequest(request); return '/api/group-overview/records?' + new URLSearchParams({ organizationId: value.orgIds[0], date: value.date, metric: value.metric, fingerprint: value.fingerprint, page: String(value.page) });
}
export function confirmGroupOverviewRecords(output, expected, expectedTotal) {
  const request = drillRequest(expected); if (!integer(expectedTotal, 0, 50000)) bad();
  const start = BigInt(request.page - 1) * 25n, length = start >= BigInt(expectedTotal) ? 0 : Number((BigInt(expectedTotal) - start) > 25n ? 25n : BigInt(expectedTotal) - start);
  if (!closed(output, ['mode', 'date', 'organization', 'metric', 'fingerprint', 'page', 'pageSize', 'total', 'items']) || output.mode !== GROUP_OVERVIEW_MODE || output.date !== request.date || !closed(output.organization, ['id', 'name']) || output.organization.id !== request.orgIds[0] || !text(output.organization.name, 500, true) || output.metric !== request.metric || output.fingerprint !== request.fingerprint || output.page !== request.page || output.pageSize !== 25 || output.total !== expectedTotal || !dense(output.items, length, length)) bad();
  const ids = new Set(); for (const item of output.items) {
    if (!closed(item, ['id', 'orgId', 'version', 'name', 'number', 'date', 'status']) || !ref(item.id) || ids.has(item.id) || item.orgId !== request.orgIds[0] || !integer(item.version, 1) || !text(item.name) || !text(item.number) || !statuses[request.metric].includes(item.status)) bad(); ids.add(item.id);
    const person = ['caseTotal', 'activeCases', 'employeeTotal', 'activeEmployees'].includes(request.metric);
    if (person ? (!text(item.name, 500, true) || !text(item.number, 500, true) || item.date !== '') : (item.name !== '' || item.number !== '' || !isGroupDate(item.date, true))) bad();
    if (['startsShifts', 'completedStartShifts'].includes(request.metric) && item.date !== request.date) bad();
    if (request.metric === 'approvedMonthRecords' && item.date.slice(0, 7) !== request.date.slice(0, 7)) bad();
  } return copy(output);
}
