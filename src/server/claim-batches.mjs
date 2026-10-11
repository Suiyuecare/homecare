import { billingDocumentVisible, billingDocumentAmount } from './billing-documents.mjs';

/** Offline company data and manually recorded replies. No official filing or dispatch. */
export const claimBatchEntity = 'claim-batches';
export const claimBatchFormat = 'local-homecare-claim-v1';
export const claimBatchEntities = {
  [claimBatchEntity]: {
    fields: 'month number billingDocumentIds sourceReference responseSourceReference responses status note',
    required: ['month', 'number', 'billingDocumentIds'], statuses: ['draft', 'verified', 'reconciling', 'closed', 'cancelled'],
    defaults: { status: 'draft', sourceReference: '', responseSourceReference: '', responses: [], note: '' },
    jsonFields: ['billingDocumentIds', 'responses'],
    maxLengths: { month: 7, number: 100, sourceReference: 2000, responseSourceReference: 2000, note: 10000 },
  },
};
export const isClaimBatchEntity = entity => entity === claimBatchEntity;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, names) => plain(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const text = (value, maximum, required = false) => typeof value === 'string' && value.length <= maximum && (!required || !!value.trim());
const ref = value => text(value, 100, true) && value === value.trim() && !/[\r\n]/.test(value);
const monthValid = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const sourceKeys = ['billingDocumentId', 'version', 'number', 'caseId', 'caseName', 'amountCents'];
const responseKeys = ['billingDocumentId', 'reference', 'status', 'amountCents', 'reason'];
const summaryKeys = ['amountCents', 'acceptedAmountCents', 'rejectedAmountCents', 'pendingAmountCents', 'unansweredAmountCents', 'sourceCount', 'responseCount'];

export function guardClaimBatchAccess(entity, ctx, _readOnly, fail) {
  if (isClaimBatchEntity(entity) && !['admin', 'finance'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '僅管理者或財務可使用離線核銷批次');
}
export function normalizeClaimBatchPayload(entity, payload) {
  if (!isClaimBatchEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && !['note', 'sourceReference', 'responseSourceReference'].includes(key) ? value.trim() : value]));
}
export function assertClaimBatchTransitionPayload(entity, payload, fail) {
  if (isClaimBatchEntity(entity) && payload.status === 'cancelled' && (!Object.hasOwn(payload, 'note') || !text(payload.note, 10000, true)))
    fail(422, 'REASON_REQUIRED', '取消批次須在本次操作明確填寫原因', { note: '本次取消原因必填' });
}
function checkIds(ids, fail) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every(ref) || new Set(ids).size !== ids.length)
    fail(422, 'INVALID_SOURCES', '請選擇1至100筆不重複的帳單', { billingDocumentIds: '同一帳單不可重複選取' });
}
function checkSources(sources, ids, fail) {
  checkIds(ids, fail);
  if (!Array.isArray(sources) || sources.length !== ids.length) fail(409, 'CLAIM_DATA_INVALID', '批次來源快照筆數無法確認');
  for (let index = 0; index < sources.length; index++) {
    const row = sources[index];
    if (!keys(row, sourceKeys) || row.billingDocumentId !== ids[index] || !Number.isSafeInteger(row.version) || row.version < 1
      || !ref(row.number) || !ref(row.caseId) || !text(row.caseName, 500) || !money(row.amountCents))
      fail(409, 'CLAIM_DATA_INVALID', '批次來源快照格式無法確認');
  }
}
export function claimBatchSummary(sources, responses, fail) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 100 || !Array.isArray(responses) || responses.length > sources.length)
    fail(422, 'INVALID_RESPONSES', '回應筆數或来源無法確認', { responses: '每筆來源最多一筆回應' });
  const sourceMap = new Map(sources.map(item => [item.billingDocumentId, item]));
  if (sourceMap.size !== sources.length) fail(409, 'CLAIM_DATA_INVALID', '來源帳單重複');
  const responseMap = new Map();
  for (const response of responses) {
    const source = response && sourceMap.get(response.billingDocumentId);
    if (!keys(response, responseKeys) || !source || responseMap.has(response.billingDocumentId)
      || !text(response.reference, 2000, true) || !['accepted', 'rejected', 'pending'].includes(response.status)
      || !money(response.amountCents) || !text(response.reason, 10000)
      || (response.status === 'accepted' ? response.amountCents !== source.amountCents : response.amountCents !== 0)
      || (response.status === 'rejected' && !response.reason.trim()))
      fail(422, 'INVALID_RESPONSES', '請核對回應來源、依據、結果與精確金額；退件須填原因', { responses: '接受金額须等來源；退件與待定填0，退件原因必填' });
    responseMap.set(response.billingDocumentId, response);
  }
  const total = { amountCents: 0n, acceptedAmountCents: 0n, rejectedAmountCents: 0n, pendingAmountCents: 0n, unansweredAmountCents: 0n };
  for (const source of sources) {
    if (!money(source.amountCents)) fail(409, 'CLAIM_DATA_INVALID', '來源金額無法確認');
    const amount = BigInt(source.amountCents), response = responseMap.get(source.billingDocumentId);
    total.amountCents += amount;
    total[!response ? 'unansweredAmountCents' : response.status === 'accepted' ? 'acceptedAmountCents' : response.status === 'rejected' ? 'rejectedAmountCents' : 'pendingAmountCents'] += amount;
    if (total.amountCents > BigInt(Number.MAX_SAFE_INTEGER)) fail(422, 'AMOUNT_OVERFLOW', '批次總額超過可精確保存範圍');
  }
  return { ...Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Number(value)])), sourceCount: sources.length, responseCount: responses.length };
}
function parentSource(db, ctx, id, fail, get, requireIssued = false) {
  const parent = get(db, ctx.orgId, 'billing-documents', id);
  if (!parent || !billingDocumentVisible(db, ctx, 'billing-documents', parent, get)) fail(422, 'INVALID_REFERENCE', '帳單或其個案不存在或不屬於本機構');
  const amount = billingDocumentAmount(parent.lineItems, fail);
  if (!keys(parent.summary, ['amountCents']) || parent.summary.amountCents !== amount || !monthValid(parent.month) || !ref(parent.number))
    fail(409, 'CLAIM_DATA_INVALID', '來源帳單保存金額或識別資料無法確認');
  if (requireIssued && parent.status !== 'issued') fail(409, 'BILLING_NOT_ISSUED', '只有已開立帳單可加入或核對批次');
  if (!['draft', 'issued', 'voided'].includes(parent.status)) fail(409, 'CLAIM_DATA_INVALID', '來源帳單狀態無法確認');
  return parent;
}
const capture = parent => ({ billingDocumentId: parent.id, version: parent.version, number: parent.number, caseId: parent.caseId, caseName: parent.caseSnapshot.name, amountCents: parent.summary.amountCents });
const quietFail = () => { throw new Error('invalid claim'); };
/** Frozen snapshots remain readable after a parent bill is voided; current same-org parents must still exist. */
export function claimBatchVisible(db, ctx, entity, item, get) {
  if (!isClaimBatchEntity(entity)) return true;
  try {
    if (!keys(item, [...claimBatchEntities[entity].fields.split(' '), 'sourceSnapshots', 'summary', 'id', 'orgId', 'version', 'createdAt', 'updatedAt'])
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || item.orgId !== ctx.orgId || !ref(item.id) || !Number.isSafeInteger(item.version) || item.version < 1
      || !monthValid(item.month) || !ref(item.number) || !claimBatchEntities[entity].statuses.includes(item.status)) return false;
    for (const [key, maximum] of Object.entries(claimBatchEntities[entity].maxLengths)) if (!text(item[key], maximum)) return false;
    checkSources(item.sourceSnapshots, item.billingDocumentIds, quietFail);
    for (const source of item.sourceSnapshots) {
      const parent = parentSource(db, ctx, source.billingDocumentId, quietFail, get);
      if (parent.month !== item.month || parent.number !== source.number || parent.caseId !== source.caseId) return false;
    }
    const summary = claimBatchSummary(item.sourceSnapshots, item.responses, quietFail);
    if (!keys(item.summary, summaryKeys) || !summaryKeys.every(key => item.summary[key] === summary[key])) return false;
    if (item.status === 'draft' && (item.responses.length || item.responseSourceReference)) return false;
    if (item.status === 'verified' && (item.responses.length || item.responseSourceReference)) return false;
    if (['verified', 'reconciling', 'closed'].includes(item.status) && !item.sourceReference.trim()) return false;
    if (['reconciling', 'closed'].includes(item.status) && (!item.responses.length || !item.responseSourceReference.trim())) return false;
    if (item.status === 'closed' && (item.responses.length !== item.sourceSnapshots.length || item.responses.some(row => row.status === 'pending'))) return false;
    if (item.status === 'cancelled' && !item.note.trim()) return false;
    return true;
  } catch { return false; }
}
export function claimBatchHistoryVisible(db, ctx, entity, snapshot, current, get) {
  return claimBatchVisible(db, ctx, entity, current, get) && claimBatchVisible(db, ctx, entity, snapshot, get)
    && snapshot.id === current.id && snapshot.month === current.month && snapshot.number === current.number;
}

export function validateClaimBatch(db, ctx, entity, data, old, fail, _dateValid, rows, get) {
  if (!isClaimBatchEntity(entity)) return;
  guardClaimBatchAccess(entity, ctx, false, fail);
  if (old && !claimBatchVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可操作批次');
  for (const [key, maximum] of Object.entries(claimBatchEntities[entity].maxLengths)) if (!text(data[key], maximum)) fail(422, 'INVALID_FIELD', '批次文字格式或長度不符', { [key]: '請核對欄位格式與長度' });
  if (!monthValid(data.month) || !ref(data.number)) fail(422, 'INVALID_IDENTITY', '請填寫有效月份與單行批次編號');
  if (!claimBatchEntities[entity].statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '批次狀態不合法');
  checkIds(data.billingDocumentIds, fail);
  if (rows(db, ctx.orgId, entity).some(item => item.id !== old?.id && item.number === data.number)) fail(409, 'DUPLICATE_NUMBER', '本機構已有相同批次編號');
  if (!old && data.status !== 'draft') fail(422, 'CLAIM_STATE', '新批次須先建立草稿');
  if (old && (data.month !== old.month || data.number !== old.number)) fail(409, 'CLAIM_IDENTITY_IMMUTABLE', '建立後不可更換月份或批次編號');
  if (old && ['closed', 'cancelled'].includes(old.status)) fail(409, 'CLAIM_LOCKED', '已完成或取消批次不可改寫');
  if (data.status === 'cancelled') {
    if (!old || !data.note.trim() || claimBatchEntities[entity].fields.split(' ').filter(key => !['status', 'note'].includes(key)).some(key => !same(data[key], old[key])))
      fail(409, 'CLAIM_LOCKED', '取消只可變更狀態與本次原因');
    data.sourceSnapshots = structuredClone(old.sourceSnapshots); data.summary = structuredClone(old.summary); return;
  }
  if (old?.status === 'draft' || !old) {
    if (!['draft', 'verified'].includes(data.status) || !Array.isArray(data.responses) || data.responses.length || data.responseSourceReference)
      fail(409, 'CLAIM_STATE', '草稿只可保存或核對，尚不可記錄回應');
    if (data.status === 'verified' && !data.sourceReference.trim()) fail(422, 'SOURCE_REQUIRED', '核對前須填寫批次人工依據', { sourceReference: '依據必填' });
    const previous = new Map((old?.sourceSnapshots || []).map(row => [row.billingDocumentId, row]));
    data.sourceSnapshots = data.billingDocumentIds.map(id => {
      const parent = parentSource(db, ctx, id, fail, get, true);
      if (parent.month !== data.month) fail(422, 'MONTH_MISMATCH', '來源帳單須與批次同月份');
      const source = capture(parent);
      if (previous.has(id) && !same(previous.get(id), source)) fail(409, 'SOURCE_CHANGED', '來源帳單已變動，請取消批次後重新建立');
      return source;
    });
  } else {
    if (!['verified', 'reconciling'].includes(old.status) || !(old.status === 'verified' ? data.status === 'reconciling' : ['reconciling', 'closed'].includes(data.status))
      || ['month', 'number', 'billingDocumentIds', 'sourceReference', 'note'].some(key => !same(data[key], old[key])))
      fail(409, 'CLAIM_LOCKED', '已核對批次來源與內容鎖定，只可保存人工回應或完成對帳');
    data.sourceSnapshots = structuredClone(old.sourceSnapshots);
    if (!text(data.responseSourceReference, 2000, true) || !Array.isArray(data.responses) || !data.responses.length)
      fail(422, 'RESPONSE_SOURCE_REQUIRED', '請填寫收到回應的依據與至少一筆回應');
  }
  for (const other of rows(db, ctx.orgId, entity)) {
    if (other.id === old?.id) continue;
    if (!claimBatchVisible(db, ctx, entity, other, get)) fail(409, 'CLAIM_DATA_INVALID', '現有批次資料無法確認，請先核對');
    if (other.status === 'cancelled') continue;
    if (!Array.isArray(other.billingDocumentIds) || !other.billingDocumentIds.every(ref)) fail(409, 'CLAIM_DATA_INVALID', '現有批次來源無法確認，請先核對');
    if (other.billingDocumentIds.some(id => data.billingDocumentIds.includes(id))) fail(409, 'SOURCE_ALREADY_BATCHED', '來源帳單已在另一個未取消批次，請先核對或取消原批次');
  }
  data.summary = claimBatchSummary(data.sourceSnapshots, data.responses, fail);
  if (data.status === 'closed' && (data.responses.length !== data.sourceSnapshots.length || data.responses.some(row => row.status === 'pending')))
    fail(409, 'RECONCILIATION_INCOMPLETE', '每筆帳單須有接受或退件回應，才能完成人工對帳');
}
export function claimBatchQuery(entity, params, fail, mode = 'list') {
  if (!isClaimBatchEntity(entity)) return {};
  const allowed = mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', 'month'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '批次查詢欄位不合法或重複');
  const integer = (key, fallback, maximum) => { const input = params.get(key) ?? String(fallback), value = Number(input);
    if (!/^[1-9]\d*$/.test(input) || /[\r\n]/.test(input) || !Number.isSafeInteger(value) || value > maximum) fail(422, 'PAGINATION', '批次分頁參數不合法'); return value; };
  const page = integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize = integer('pageSize', 25, 100), q = params.get('q') || '', status = params.get('status') || '', month = params.get('month') || '', compare = params.get('compare') ?? undefined;
  if (q.length > 200 || (params.has('month') && !monthValid(month)) || (params.has('status') && !claimBatchEntities[entity].statuses.includes(status)) || (compare !== undefined && compare !== 'previous')) fail(422, 'INVALID_QUERY', '批次查詢值不合法');
  return { page, pageSize, q, status, month, compare };
}
export function filterClaimBatches(entity, items, query) {
  if (!isClaimBatchEntity(entity)) return items;
  const q = query.q.toLowerCase();
  return items.filter(item => (!query.month || item.month === query.month) && (!query.status || item.status === query.status)
    && (!q || [item.number, item.sourceReference, item.responseSourceReference, item.note, ...item.sourceSnapshots.flatMap(row => [row.number, row.caseName]), ...item.responses.flatMap(row => [row.reference, row.reason])].some(value => typeof value === 'string' && value.toLowerCase().includes(q))));
}
export function claimCsvCell(value) {
  let output = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(output) || /^[\t\r\n]/.test(output)) output = "'" + output;
  return '"' + output.replace(/"/g, '""') + '"';
}
export function renderClaimBatchExport(db, ctx, item, format, fail, get) {
  guardClaimBatchAccess(claimBatchEntity, ctx, true, fail);
  if (!claimBatchVisible(db, ctx, claimBatchEntity, item, get)) fail(404, 'NOT_FOUND', '找不到可匯出批次');
  if (!['verified', 'reconciling', 'closed'].includes(item.status)) fail(409, 'CLAIM_EXPORT_STATE', '請先核對並鎖定批次後匯出');
  if (!['json', 'csv'].includes(format)) fail(422, 'INVALID_FORMAT', '只支援本機JSON或CSV');
  const warning = '本機人工核銷資料；非FA或政府正式格式；未送出申報。人工對帳完成不代表政府核准。';
  const replies = new Map(item.responses.map(row => [row.billingDocumentId, row]));
  const lines = item.sourceSnapshots.map(source => ({ ...source, response: replies.has(source.billingDocumentId) ? structuredClone(replies.get(source.billingDocumentId)) : null }));
  const document = { format: claimBatchFormat, officialSubmission: false, warning, batch: { id: item.id, version: item.version, month: item.month, number: item.number, status: item.status, sourceReference: item.sourceReference, responseSourceReference: item.responseSourceReference, note: item.note, summary: structuredClone(item.summary) }, lines };
  if (format === 'json') return { contentType: 'application/json; charset=utf-8', filename: `local-claim-${item.id}-v${item.version}.json`, body: JSON.stringify(document, null, 2) + '\n' };
  const header = ['format', 'officialSubmission', 'warning', 'batchNumber', 'batchMonth', 'batchVersion', 'batchStatus', 'billingDocumentId', 'billingVersion', 'billNumber', 'caseId', 'savedCaseName', 'sourceAmountCents', 'responseStatus', 'responseAmountCents', 'responseReference', 'responseReason', 'sourceReference', 'responseSourceReference'];
  const output = [header, ...lines.map(line => [claimBatchFormat, 'false', warning, item.number, item.month, item.version, item.status, line.billingDocumentId, line.version, line.number, line.caseId, line.caseName, line.amountCents, line.response?.status ?? 'unanswered', line.response?.amountCents ?? '', line.response?.reference ?? '', line.response?.reason ?? '', item.sourceReference, item.responseSourceReference])];
  return { contentType: 'text/csv; charset=utf-8', filename: `local-claim-${item.id}-v${item.version}.csv`, body: '\uFEFF' + output.map(row => row.map(claimCsvCell).join(',')).join('\r\n') + '\r\n' };
}
