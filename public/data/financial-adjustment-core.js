import { confirmFinancialOutput } from './financial-output-editor.js';

export const FINANCIAL_ADJUSTMENT_NOTICE = '人工調整紀錄；原單據保持不變，尚未代表正式收退款、薪資付款、稅額或核銷。';
export const financialAdjustmentStatuses = Object.freeze({ draft: '草稿', submitted: '待覆核', approved: '已覆核', rejected: '已退回' });
export const financialAdjustmentSourceStatuses = Object.freeze({ billing: 'issued', payroll: 'closed' });
export const FINANCIAL_ADJUSTMENT_DATA_KEYS = Object.freeze(['sourceKind', 'sourceId', 'sourceVersion', 'number', 'effectiveMonth', 'direction', 'amountCents', 'reason', 'status', 'sourceSnapshot', 'createdBy', 'submittedBy', 'submittedAt', 'reviewedBy', 'reviewedAt', 'reviewNote']);
const META = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const CURRENT = ['sourceCurrentVersion', 'sourceCurrentStatus', 'sourceEligible'];
const invalid = () => { throw new Error('人工財務調整的保存來源、版次或狀態未確認，請重新讀取。'); };
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = value => typeof value === 'string' && /^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = (value, maximum) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const ref = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500 && !/[\r\n]/.test(value);
const month = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) { const property = Object.getOwnPropertyDescriptor(value, key); if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) invalid(); }
  return value;
}
function dense(items, maximum) {
  if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype || items.length > maximum || Reflect.ownKeys(items).length !== items.length + 1) invalid();
  for (let i = 0; i < items.length; i++) { const property = Object.getOwnPropertyDescriptor(items, String(i)); if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) invalid(); }
  return items;
}
function assertSaved(item, expected, projected) {
  closed(item, [...FINANCIAL_ADJUSTMENT_DATA_KEYS, ...META, ...(projected ? CURRENT : [])]);
  if (!uuid(item.id) || !ref(item.orgId) || !integer(item.version, 1) || !instant(item.createdAt) || !instant(item.updatedAt) || item.updatedAt < item.createdAt
      || !Object.hasOwn(financialAdjustmentSourceStatuses, item.sourceKind) || !ref(item.sourceId) || !integer(item.sourceVersion, 1) || !text(item.number, 100)
      || !month(item.effectiveMonth) || !['debit', 'credit'].includes(item.direction) || !integer(item.amountCents) || !text(item.reason, 2000)
      || !Object.hasOwn(financialAdjustmentStatuses, item.status) || !uuid(item.createdBy)) invalid();
  if (expected && (item.orgId !== expected.orgId || expected.id !== undefined && item.id !== expected.id || expected.version !== undefined && item.version !== expected.version)) invalid();
  confirmFinancialOutput(item.sourceSnapshot, { kind: item.sourceKind, id: item.sourceId, orgId: item.orgId, version: item.sourceVersion });
  if (item.sourceSnapshot.record.status !== financialAdjustmentSourceStatuses[item.sourceKind]) invalid();
  if (item.status === 'draft') {
    if (item.submittedBy !== null || item.submittedAt !== null || item.reviewedBy !== null || item.reviewedAt !== null || item.reviewNote !== '') invalid();
  } else {
    if (!uuid(item.submittedBy) || !instant(item.submittedAt) || item.submittedAt < item.createdAt || item.submittedAt > item.updatedAt) invalid();
    if (item.status === 'submitted') { if (item.reviewedBy !== null || item.reviewedAt !== null || item.reviewNote !== '') invalid(); }
    else if (!uuid(item.reviewedBy) || !instant(item.reviewedAt) || item.reviewedAt < item.submittedAt || item.reviewedAt > item.updatedAt || !text(item.reviewNote, 2000)) invalid();
  }
  if (projected) {
    const allowed = item.sourceKind === 'billing' ? ['draft', 'issued', 'voided'] : ['draft', 'reviewed', 'closed', 'voided'];
    if (!integer(item.sourceCurrentVersion, item.sourceVersion) || !allowed.includes(item.sourceCurrentStatus)
        || item.sourceEligible !== (item.sourceCurrentVersion === item.sourceVersion && item.sourceCurrentStatus === financialAdjustmentSourceStatuses[item.sourceKind])) invalid();
  }
  return item;
}
export function confirmFinancialAdjustmentSaved(item, expected) { return assertSaved(item, expected, false); }
export function confirmFinancialAdjustment(item, expected) { return assertSaved(item, expected, true); }
export function confirmFinancialAdjustmentList(response, request) {
  closed(response, ['orgId', 'items', 'total', 'page', 'pageSize', 'notice']);
  if (response.orgId !== request.orgId || response.notice !== FINANCIAL_ADJUSTMENT_NOTICE || response.page !== request.page || response.pageSize !== request.pageSize
      || !integer(response.total) || !integer(response.page, 1) || !integer(response.pageSize, 1) || response.pageSize > 100) invalid();
  const seen = new Set(), items = dense(response.items, response.pageSize);
  if (items.length !== Math.min(response.pageSize, Math.max(0, response.total - (response.page - 1) * response.pageSize))) invalid();
  for (const item of items) { confirmFinancialAdjustment(item, { orgId: request.orgId }); if (seen.has(item.id) || request.status && item.status !== request.status || request.sourceKind && item.sourceKind !== request.sourceKind) invalid(); seen.add(item.id); }
  return response;
}
export function confirmFinancialAdjustmentHistory(response, request) {
  closed(response, ['orgId', 'id', 'items', 'total', 'notice']);
  if (response.orgId !== request.orgId || response.id !== request.id || response.notice !== FINANCIAL_ADJUSTMENT_NOTICE || !integer(response.total, 1)) invalid();
  const items = dense(response.items, 10000); if (items.length !== response.total) invalid();
  // Validate every row and nested snapshot before reading an adjacent row.
  // Response accessors must never run, including in an older history entry.
  for (const [index, row] of items.entries()) {
    closed(row, ['version', 'source', 'createdAt', 'snapshot']);
    if (row.version !== response.total - index || !instant(row.createdAt) || !['financial-adjustment.create', 'financial-adjustment.update', 'financial-adjustment.submit', 'financial-adjustment.review'].includes(row.source)) invalid();
    confirmFinancialAdjustmentSaved(row.snapshot, { orgId: request.orgId, id: request.id, version: row.version }); if (row.snapshot.updatedAt !== row.createdAt) invalid();
  }
  for (const [index, row] of items.entries()) {
    const current = row.snapshot, previous = items[index + 1]?.snapshot;
    if (row.version === 1) { if (row.source !== 'financial-adjustment.create' || current.status !== 'draft') invalid(); }
    else {
      if (!previous || !['sourceKind', 'sourceId', 'sourceVersion', 'createdBy'].every(key => current[key] === previous[key]) || JSON.stringify(current.sourceSnapshot) !== JSON.stringify(previous.sourceSnapshot)) invalid();
      if (row.source === 'financial-adjustment.update') { if (previous.status !== 'draft' || current.status !== 'draft') invalid(); }
      else if (row.source === 'financial-adjustment.submit') { if (previous.status !== 'draft' || current.status !== 'submitted') invalid(); }
      else if (row.source === 'financial-adjustment.review') { if (previous.status !== 'submitted' || !['approved', 'rejected'].includes(current.status) || current.submittedBy !== previous.submittedBy || current.submittedAt !== previous.submittedAt) invalid(); }
      else invalid();
      if (row.source !== 'financial-adjustment.update' && !['number', 'effectiveMonth', 'direction', 'amountCents', 'reason'].every(key => current[key] === previous[key])) invalid();
    }
  }
  return response;
}
export function confirmFinancialAdjustmentAck(response, request) {
  closed(response, ['item', 'notice']); if (response.notice !== FINANCIAL_ADJUSTMENT_NOTICE) invalid();
  confirmFinancialAdjustment(response.item, { orgId: request.orgId, ...(request.id ? { id: request.id } : {}), version: request.version === undefined ? 1 : request.version + 1 });
  if (response.item.sourceEligible !== true) invalid();
  const payload = request.payload;
  if (payload) for (const key of ['sourceKind', 'sourceId', 'sourceVersion', 'number', 'effectiveMonth', 'direction', 'amountCents', 'reason']) if (Object.hasOwn(payload, key) && response.item[key] !== payload[key]) invalid();
  if (payload && Object.hasOwn(payload, 'decision') && (response.item.status !== payload.decision || response.item.reviewNote !== payload.reviewNote)) invalid();
  if (request.status && response.item.status !== request.status) invalid();
  if (request.original) {
    confirmFinancialAdjustment(request.original, { orgId: request.orgId, id: request.id, version: request.version });
    for (const key of ['sourceKind', 'sourceId', 'sourceVersion', 'sourceSnapshot', 'createdBy', 'createdAt'])
      if (JSON.stringify(response.item[key]) !== JSON.stringify(request.original[key])) invalid();
    if (request.status !== 'draft') for (const key of ['number', 'effectiveMonth', 'direction', 'amountCents', 'reason'])
      if (response.item[key] !== request.original[key]) invalid();
    if (payload?.decision && (response.item.submittedBy !== request.original.submittedBy || response.item.submittedAt !== request.original.submittedAt)) invalid();
  }
  return response;
}
export function buildFinancialAdjustmentCreate(values) {
  const payload = { sourceKind: values.sourceKind, sourceId: values.sourceId, sourceVersion: values.sourceVersion, number: typeof values.number === 'string' ? values.number.trim() : '', effectiveMonth: values.effectiveMonth, direction: values.direction, amountCents: values.amountCents, reason: typeof values.reason === 'string' ? values.reason.trim() : '' };
  if (!Object.hasOwn(financialAdjustmentSourceStatuses, payload.sourceKind) || !ref(payload.sourceId) || !integer(payload.sourceVersion, 1) || !text(payload.number, 100) || !month(payload.effectiveMonth) || !['debit', 'credit'].includes(payload.direction) || !integer(payload.amountCents) || !text(payload.reason, 2000)) invalid();
  return payload;
}
export function buildFinancialAdjustmentDraft(values, version) {
  const payload = { version, number: typeof values.number === 'string' ? values.number.trim() : '', effectiveMonth: values.effectiveMonth, direction: values.direction, amountCents: values.amountCents, reason: typeof values.reason === 'string' ? values.reason.trim() : '' };
  if (!integer(version, 1) || !text(payload.number, 100) || !month(payload.effectiveMonth) || !['debit', 'credit'].includes(payload.direction) || !integer(payload.amountCents) || !text(payload.reason, 2000)) invalid();
  return payload;
}
export function financialAdjustmentSourceLabel(item) {
  confirmFinancialAdjustment(item, { orgId: item.orgId });
  const record = item.sourceSnapshot.record, party = item.sourceKind === 'billing' ? record.caseSnapshot : record.employeeSnapshot;
  return `${item.sourceKind === 'billing' ? '帳單' : '薪資'} ${record.number}・${party.name}・原版 ${item.sourceVersion}`;
}
