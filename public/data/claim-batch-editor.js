import { formatBillingCents, parseBillingMoney } from './billing-document-editor.js';

const fields = ['month', 'number', 'billingDocumentIds', 'sourceReference', 'responseSourceReference', 'responses', 'status', 'note'];
const sourceKeys = ['billingDocumentId', 'version', 'number', 'caseId', 'caseName', 'amountCents'];
const responseKeys = ['billingDocumentId', 'reference', 'status', 'amountCents', 'reason'];
const summaryKeys = ['amountCents', 'acceptedAmountCents', 'rejectedAmountCents', 'pendingAmountCents', 'unansweredAmountCents', 'sourceCount', 'responseCount'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, names) => plain(value) && Reflect.ownKeys(value).every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
}) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const area = value => value.replace(/\r\n?/g, '\n');
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
function text(values, key) {
  const descriptor = plain(values) && Object.getOwnPropertyDescriptor(values, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid(key, '表單文字無法確認。');
  return descriptor.value;
}
const monthValid = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const id = value => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 100 && !/[\r\n]/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const safeArray = (value, minimum = 0, maximum = 100) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < minimum || length.value > maximum) return false;
  const names = Reflect.ownKeys(value);
  if (names.length !== length.value + 1 || names.some(key => typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length.value)))) return false;
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
};
export const claimStatuses = { draft: '草稿', verified: '已核對鎖定', reconciling: '人工對帳中', closed: '人工對帳完成', cancelled: '已取消' };
export const claimResponseStatuses = { accepted: '人工記錄接受', rejected: '人工記錄退件', pending: '人工記錄待定' };

export function claimSummary(sources, responses) {
  if (!safeArray(sources, 1) || !safeArray(responses) || responses.length > sources.length) invalid('responses', '批次來源或回應筆數無法確認。');
  const ids = new Set(), mapping = new Map();
  for (const source of sources) {
    if (!closed(source, sourceKeys) || !id(source.billingDocumentId) || ids.has(source.billingDocumentId) || !id(source.caseId)
      || !id(source.number) || typeof source.caseName !== 'string' || source.caseName.length > 500 || !Number.isSafeInteger(source.version) || source.version < 1 || !money(source.amountCents)) invalid('billingDocumentIds', '來源快照無法確認。');
    ids.add(source.billingDocumentId); mapping.set(source.billingDocumentId, source);
  }
  const replyMap = new Map();
  for (const response of responses) {
    if (!closed(response, responseKeys)) invalid('responses', '保存回應格式無法確認。');
    const source = mapping.get(response.billingDocumentId);
    if (!source || replyMap.has(response.billingDocumentId) || typeof response.reference !== 'string' || !response.reference.trim()
      || response.reference.length > 2000 || !Object.hasOwn(claimResponseStatuses, response.status) || !money(response.amountCents)
      || typeof response.reason !== 'string' || response.reason.length > 10000 || (response.status === 'rejected' && !response.reason.trim())
      || response.amountCents !== (response.status === 'accepted' ? source.amountCents : 0)) invalid('responses', '保存回應或精確金額無法確認。');
    replyMap.set(response.billingDocumentId, response);
  }
  const total = { amountCents: 0n, acceptedAmountCents: 0n, rejectedAmountCents: 0n, pendingAmountCents: 0n, unansweredAmountCents: 0n };
  for (const source of sources) {
    const amount = BigInt(source.amountCents), reply = replyMap.get(source.billingDocumentId);
    total.amountCents += amount;
    total[!reply ? 'unansweredAmountCents' : reply.status === 'accepted' ? 'acceptedAmountCents' : reply.status === 'rejected' ? 'rejectedAmountCents' : 'pendingAmountCents'] += amount;
    if (total.amountCents > BigInt(Number.MAX_SAFE_INTEGER)) invalid('billingDocumentIds', '批次總額超出可精確保存範圍。');
  }
  return { ...Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Number(value)])), sourceCount: sources.length, responseCount: responses.length };
}
/** Closed known-field projections for current and history display. Never expand unknown nested data. */
export function claimSourcesForDisplay(value) {
  try { claimSummary(value, []); return value.map(row => Object.fromEntries(sourceKeys.map(key => [key, row[key]]))); } catch { return null; }
}
export function claimResponsesForDisplay(value) {
  if (!safeArray(value)) return null;
  const ids = new Set(), result = [];
  for (const row of value) {
    if (!closed(row, responseKeys) || !id(row.billingDocumentId) || ids.has(row.billingDocumentId) || typeof row.reference !== 'string' || !row.reference.trim()
      || row.reference.length > 2000 || !Object.hasOwn(claimResponseStatuses, row.status) || !money(row.amountCents) || typeof row.reason !== 'string' || row.reason.length > 10000
      || (row.status !== 'accepted' && row.amountCents !== 0) || (row.status === 'rejected' && !row.reason.trim())) return null;
    ids.add(row.billingDocumentId); result.push(Object.fromEntries(responseKeys.map(key => [key, row[key]])));
  }
  return result;
}
export function claimSummaryForDisplay(value) {
  if (!closed(value, summaryKeys) || !summaryKeys.every(key => money(value[key])) || value.sourceCount < 1 || value.sourceCount > 100 || value.responseCount > value.sourceCount
    || ['acceptedAmountCents', 'rejectedAmountCents', 'pendingAmountCents', 'unansweredAmountCents'].reduce((sum, key) => sum + BigInt(value[key]), 0n) !== BigInt(value.amountCents)) return null;
  return Object.fromEntries(summaryKeys.map(key => [key, value[key]]));
}
/** Confirm complete known business fields, derived values, immutable identity and exact ACK version. */
export function checkClaimBatchRecord(result, { id: recordId, orgId, original, payload } = {}) {
  const itemDescriptor = plain(result) && Object.getOwnPropertyDescriptor(result, 'item');
  const item = itemDescriptor && Object.hasOwn(itemDescriptor, 'value') ? itemDescriptor.value : undefined;
  if (!closed(item, [...fields, 'sourceSnapshots', 'summary', 'id', 'orgId', 'version', 'createdAt', 'updatedAt']) || !id(item.id) || item.orgId !== orgId
    || (recordId && item.id !== recordId) || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string'
    || !monthValid(item.month) || !id(item.number) || !Object.hasOwn(claimStatuses, item.status) || !safeArray(item.billingDocumentIds, 1) || !safeArray(item.sourceSnapshots, 1) || !safeArray(item.responses)
    || fields.filter(key => !['billingDocumentIds', 'responses'].includes(key)).some(key => typeof item[key] !== 'string')
    || item.sourceReference.length > 2000 || item.responseSourceReference.length > 2000 || item.note.length > 10000) invalid('number', '無法確認保存批次，請保留輸入並重新讀取。');
  const summary = claimSummary(item.sourceSnapshots, item.responses);
  if (!same(item.billingDocumentIds, item.sourceSnapshots.map(source => source.billingDocumentId)) || !closed(item.summary, summaryKeys)
    || !summaryKeys.every(key => item.summary[key] === summary[key])) invalid('number', '保存批次來源與總額無法確認。');
  if (['draft', 'verified'].includes(item.status) && (item.responses.length || item.responseSourceReference)) invalid('number', '草稿或已核對批次回應狀態無法確認。');
  if (['verified', 'reconciling', 'closed'].includes(item.status) && !item.sourceReference.trim()) invalid('sourceReference', '保存批次依據無法確認。');
  if (['reconciling', 'closed'].includes(item.status) && (!item.responses.length || !item.responseSourceReference.trim())) invalid('responseSourceReference', '保存回應依據無法確認。');
  if (item.status === 'closed' && (item.responses.length !== item.sourceSnapshots.length || item.responses.some(row => row.status === 'pending'))) invalid('responses', '對帳完成狀態無法確認。');
  if (item.status === 'cancelled' && !item.note.trim()) invalid('note', '取消原因無法確認。');
  if (payload) {
    if (item.version !== (original ? original.version + 1 : 1) || Object.entries(payload).some(([key, value]) => key !== 'version' && !same(item[key], value))
      || (original && fields.some(key => !same(item[key], Object.hasOwn(payload, key) ? payload[key] : original[key])))) invalid('number', '無法確認儲存結果；請保留輸入並重新讀取。');
    if (original && original.status !== 'draft' && !same(item.sourceSnapshots, original.sourceSnapshots)) invalid('number', '已核對來源快照不可變更。');
    if (original) {
      const oldSources = new Map(original.sourceSnapshots.map(row => [row.billingDocumentId, row]));
      if (item.sourceSnapshots.some(row => oldSources.has(row.billingDocumentId) && !same(row, oldSources.get(row.billingDocumentId)))) invalid('number', '未更換來源的保存快照不可變更。');
    }
    if (!original && (!same(item.responses, []) || item.responseSourceReference !== '')) invalid('number', '新增保存回應無法確認。');
  }
  return item;
}
export function createClaimBatchDraftEditor({ existing, bills = [], month = '' } = {}) {
  if (existing) { checkClaimBatchRecord({ item: existing }, { orgId: existing.orgId }); if (existing.status !== 'draft') invalid('status', '只可編輯草稿。'); }
  if (!safeArray(bills, 0, 10000) || bills.some(item => !id(item.id) || item.status !== 'issued' || item.month !== (existing?.month || month)) || new Set(bills.map(item => item.id)).size !== bills.length) invalid('billingDocumentIds', '同月份帳單選項無法確認。');
  const source = existing || { month, number: '', billingDocumentIds: [], sourceReference: '', note: '' };
  const initial = { month: source.month, number: source.number, billingDocumentIds: [...source.billingDocumentIds], sourceReference: source.sourceReference, note: source.note };
  const baseline = { ...initial, sourceReference: area(source.sourceReference), note: area(source.note) };
  const controls = [{ name: 'month', label: '批次月份', type: 'month', readOnly: true, required: true },
    { name: 'number', label: '批次編號', required: true, readOnly: !!existing, maxLength: 100 },
    { name: 'billingDocumentIds', label: '同月份已開立帳單', type: 'checkbox-group', required: true, wide: true,
      options: bills.map(item => ({ value: item.id, label: `${item.number} · ${item.caseSnapshot.name} · ${formatBillingCents(item.summary.amountCents)} 元` })),
      help: '選擇1至100筆；已在其他未取消批次的帳單不能再次保存。' },
    { name: 'sourceReference', label: '批次人工依據', type: 'textarea', maxLength: 2000, wide: true, help: '核對鎖定前必填；不代表已正式送出。' },
    { name: 'note', label: '備註', type: 'textarea', maxLength: 10000, wide: true }];
  return { fields: controls, initial, initialDisplay: structuredClone(baseline), buildPayload(values) {
    if (!closed(values, controls.map(field => field.name))) invalid('number', '表單包含未知或缺少欄位。');
    if (text(values, 'month') !== baseline.month || (existing && text(values, 'number') !== baseline.number)) invalid('number', '已建立的月份與編號不可更換。');
    const number = text(values, 'number').trim(); if (!monthValid(source.month) || !id(number)) invalid('number', '請填寫有效月份与單行編號。');
    const selected = values.billingDocumentIds;
    if (!safeArray(selected, 1) || new Set(selected).size !== selected.length || selected.some(value => !bills.some(item => item.id === value))) invalid('billingDocumentIds', '請選擇1至100筆已確認帳單。');
    const payload = existing ? {} : { month: source.month, number, billingDocumentIds: [...selected], status: 'draft' };
    if (existing && (selected.length !== source.billingDocumentIds.length || selected.some(value => !source.billingDocumentIds.includes(value)))) payload.billingDocumentIds = [...selected];
    for (const key of ['sourceReference', 'note']) { const value = text(values, key);
      if (value.length > (key === 'note' ? 10000 : 2000)) invalid(key, '文字超過可保存長度。');
      if (!existing || (value !== baseline[key] && value !== source[key])) payload[key] = value;
    }
    return payload;
  } };
}
export function createClaimResponseEditor(existing, billingDocumentId) {
  checkClaimBatchRecord({ item: existing }, { orgId: existing.orgId });
  if (!['verified', 'reconciling'].includes(existing.status)) invalid('status', '此批次不可再記錄回應。');
  const source = existing.sourceSnapshots.find(row => row.billingDocumentId === billingDocumentId);
  if (!source) invalid('responses', '回應來源帳單無法確認。');
  const old = existing.responses.find(row => row.billingDocumentId === billingDocumentId);
  const initial = { responseSourceReference: existing.responseSourceReference, reference: old?.reference || '', status: old?.status || 'accepted',
    amount: formatBillingCents(old?.amountCents ?? source.amountCents), reason: old?.reason || '' };
  const baseline = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, ['responseSourceReference', 'reference', 'reason'].includes(key) ? area(value) : value]));
  const controls = [{ name: 'responseSourceReference', label: '收到回應的共同依據', type: 'textarea', required: true, maxLength: 2000, wide: true },
    { name: 'reference', label: '本筆人工外部回應編號或依據', type: 'textarea', required: true, maxLength: 2000, wide: true },
    { name: 'status', label: '人工記錄回應結果', type: 'select', required: true, options: Object.entries(claimResponseStatuses).map(([value, label]) => ({ value, label })) },
    { name: 'amount', label: '回應接受金額（元）', inputMode: 'decimal', required: true, maxLength: 20, help: `接受須等於保存來源 ${formatBillingCents(source.amountCents)} 元；退件與待定填0。` },
    { name: 'reason', label: '退件原因或回應說明', type: 'textarea', maxLength: 10000, wide: true, help: '退件必須填寫人工收到的原因。' }];
  return { initial, initialDisplay: { ...baseline }, fields: controls, buildPayload(values) {
    if (!closed(values, controls.map(field => field.name))) invalid('responses', '回應表單包含未知或缺少欄位。');
    const value = key => text(values, key) === baseline[key] ? (key === 'responseSourceReference' ? existing.responseSourceReference : old?.[key] ?? initial[key]) : text(values, key);
    const reference = value('reference'), reason = value('reason'), responseSourceReference = value('responseSourceReference'), status = text(values, 'status');
    if (!responseSourceReference.trim() || responseSourceReference.length > 2000) invalid('responseSourceReference', '請填寫收到回應的共同依據。');
    if (!reference.trim() || reference.length > 2000) invalid('reference', '請填寫本筆人工回應依據。');
    if (!Object.hasOwn(claimResponseStatuses, status)) invalid('status', '請選擇回應結果。');
    if (reason.length > 10000 || (status === 'rejected' && !reason.trim())) invalid('reason', '退件須填寫原因。');
    const amountCents = parseBillingMoney(text(values, 'amount'), { key: 'amount', maxCents: Number.MAX_SAFE_INTEGER });
    if (amountCents !== (status === 'accepted' ? source.amountCents : 0)) invalid('amount', '接受須等於來源金額；退件與待定請填0。');
    const response = { billingDocumentId, reference, status, amountCents, reason };
    const responses = old ? existing.responses.map(row => row.billingDocumentId === billingDocumentId ? response : structuredClone(row)) : [...structuredClone(existing.responses), response];
    const payload = {}; if (existing.status !== 'reconciling') payload.status = 'reconciling';
    if (responseSourceReference !== existing.responseSourceReference) payload.responseSourceReference = responseSourceReference;
    if (!same(responses, existing.responses)) payload.responses = responses;
    return payload;
  } };
}
