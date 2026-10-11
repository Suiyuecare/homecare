import { checkBillingRecord, formatBillingCents } from './billing-document-editor.js';
import { assertPayrollStatement } from './payroll-statement-editor.js';

export const FINANCIAL_OUTPUT_NOTICE = '本機保存人工紀錄；不代表正式憑證、申報或付款。';
export const FINANCIAL_OUTPUT_TITLES = Object.freeze({ billing: '人工帳單保存明細', payroll: '人工薪資結算保存明細' });
const fail = () => { throw new Error('保存明細輸出回應未確認，請重新讀取目前資料後核對。'); };
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(); }
  return value;
}
function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 100) fail();
  const keys = Reflect.ownKeys(value); if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string' || key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))) fail();
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(); }
  return value;
}
const text = (value, max, required = false) => { if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(); };
const integer = (value, min = 0) => { if (!Number.isSafeInteger(value) || value < min) fail(); };
const ref = value => { text(value, 500, true); if (value !== value.trim() || /[\r\n]/.test(value)) fail(); };
const iso = value => { if (typeof value !== 'string' || value.length !== 24 || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); };

/** Descriptor-first closed wire validation, before any clone or old owner validator. */
export function confirmFinancialOutput(response, request) {
  closed(request, ['kind', 'id', 'orgId', 'version']);
  const { kind, id, orgId, version } = request;
  if (typeof kind !== 'string' || !Object.hasOwn(FINANCIAL_OUTPUT_TITLES, kind)) fail();
  ref(id); ref(orgId); integer(version, 1);
  closed(response, ['kind', 'title', 'organization', 'record', 'note']);
  if (response.kind !== kind || response.title !== FINANCIAL_OUTPUT_TITLES[kind] || response.note !== FINANCIAL_OUTPUT_NOTICE) fail();
  closed(response.organization, ['id', 'name']);
  if (response.organization.id !== orgId) fail(); text(response.organization.name, 500, true);
  const item = response.record, payroll = kind === 'payroll';
  closed(item, ['id', 'orgId', 'version', 'createdAt', 'updatedAt', payroll ? 'employeeId' : 'caseId', 'month', 'number', 'lineItems', 'sourceReference', 'status', 'note', 'summary', payroll ? 'employeeSnapshot' : 'caseSnapshot']);
  if (item.id !== id || item.orgId !== orgId || item.version !== version) fail();
  iso(item.createdAt); iso(item.updatedAt); if (item.updatedAt < item.createdAt) fail();
  ref(item[payroll ? 'employeeId' : 'caseId']); if (!payroll && item.caseId.length > 100) fail();
  text(item.month, 7, true); if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(item.month) || item.month.length !== 7) fail();
  text(item.number, 100, true); if (!payroll && /[\r\n]/.test(item.number)) fail(); text(item.status, 20, true);
  text(item.sourceReference, payroll ? 500 : 2000); text(item.note, 10000);
  const snapshot = item[payroll ? 'employeeSnapshot' : 'caseSnapshot'];
  closed(snapshot, ['id', 'name', payroll ? 'employeeNo' : 'caseNo']);
  if (snapshot.id !== item[payroll ? 'employeeId' : 'caseId']) fail(); text(snapshot.name, 500); text(snapshot[payroll ? 'employeeNo' : 'caseNo'], 500);
  for (const line of array(item.lineItems)) {
    closed(line, payroll ? ['label', 'kind', 'amountCents'] : ['label', 'quantity', 'unitPriceCents']);
    text(line.label, payroll ? 100 : 300, true);
    if (payroll) { if (!['earning', 'deduction'].includes(line.kind)) fail(); integer(line.amountCents); if (line.amountCents > 1000000000) fail(); }
    else { if (/[\r\n]/.test(line.label)) fail(); integer(line.quantity, 1); integer(line.unitPriceCents); if (line.quantity > 10000 || line.unitPriceCents > 1000000000) fail(); }
  }
  closed(item.summary, payroll ? ['earningCents', 'deductionCents', 'netCents'] : ['amountCents']);
  for (const value of Object.values(item.summary)) integer(value);
  // All reachable known descriptors and primitive types are now closed.
  const copy = JSON.parse(JSON.stringify(response));
  try {
    if (payroll) assertPayrollStatement(copy.record, { orgId, id, version });
    else checkBillingRecord({ item: copy.record }, { entity: 'billing-documents', orgId, id });
  } catch { fail(); }
  return copy;
}
export function financialOutputPath(request, csv = false) {
  closed(request, ['kind', 'id', 'orgId', 'version']);
  if (typeof request.kind !== 'string' || !Object.hasOwn(FINANCIAL_OUTPUT_TITLES, request.kind)) fail();
  ref(request.id); ref(request.orgId); integer(request.version, 1);
  return `/api/financial-outputs/${request.kind}/id-${encodeURIComponent(request.id)}${csv ? '/export.csv' : ''}?version=${request.version}`;
}
export const financialOutputMoney = cents => `${formatBillingCents(cents)} 元`;
