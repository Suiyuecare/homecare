/** Local manually entered bills and receipt records. Never execute a payment. */
export const billingDocumentEntity = 'billing-documents';
export const paymentReceiptEntity = 'payment-receipts';
export const billingDocumentEntities = {
  [billingDocumentEntity]: {
    fields: 'caseId month number lineItems sourceReference status note', required: ['caseId', 'month', 'number', 'lineItems'],
    statuses: ['draft', 'issued', 'voided'], defaults: { status: 'draft', sourceReference: '', note: '' },
    jsonFields: ['lineItems'], maxLengths: { caseId: 100, month: 7, number: 100, sourceReference: 2000, note: 10000 },
  },
  [paymentReceiptEntity]: {
    fields: 'billingDocumentId date amountCents method reference status note', required: ['billingDocumentId', 'date', 'amountCents', 'method'],
    statuses: ['active', 'cancelled'], defaults: { status: 'active', reference: '', note: '' },
    jsonFields: ['amountCents'], maxLengths: { billingDocumentId: 100, date: 10, method: 20, reference: 500, note: 10000 },
  },
};
export const isBillingDocumentEntity = entity => Object.hasOwn(billingDocumentEntities, entity);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const monthValid = value => typeof value === 'string' && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);

export function guardBillingDocumentAccess(entity, ctx, _readOnly, fail) {
  if (isBillingDocumentEntity(entity) && !['admin', 'finance'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或財務可使用人工帳單與收款紀錄');
}
export function normalizeBillingDocumentPayload(entity, payload) {
  if (!isBillingDocumentEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && key !== 'note' ? value.trim() : value]));
}
/** Runs before merge, so an old note is never silently treated as a new reason. */
export function assertBillingDocumentTransitionPayload(entity, payload, fail) {
  if (!isBillingDocumentEntity(entity)) return;
  if ((entity === billingDocumentEntity && payload.status === 'voided') || (entity === paymentReceiptEntity && payload.status === 'cancelled')) {
    if (!Object.hasOwn(payload, 'note') || typeof payload.note !== 'string' || !payload.note.trim())
      fail(422, 'REASON_REQUIRED', '請在本次操作明確填寫作廢或取消原因', { note: '本次原因必填' });
  }
}

export function billingDocumentAmount(lineItems, fail) {
  if (!Array.isArray(lineItems) || lineItems.length < 1 || lineItems.length > 100)
    fail(422, 'INVALID_LINE_ITEMS', '請填寫1至100筆帳單明細', { lineItems: '明細筆數須介於1至100' });
  let total = 0n;
  for (let index = 0; index < lineItems.length; index++) {
    const item = lineItems[index];
    if (!plain(item) || Object.keys(item).sort().join(',') !== 'label,quantity,unitPriceCents'
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 300 || /[\r\n]/.test(item.label)
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000
      || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 || item.unitPriceCents > 1000000000)
      fail(422, 'INVALID_LINE_ITEMS', '請檢查明細名稱、正整數數量及單價', { lineItems: `第${index + 1}筆明細格式或範圍不符` });
    const amount = BigInt(item.quantity) * BigInt(item.unitPriceCents);
    total += amount;
    if (amount > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER))
      fail(422, 'AMOUNT_OVERFLOW', '帳單總額超過可精確保存的範圍', { lineItems: '請減少數量或單價' });
  }
  return Number(total);
}

function issuedAmount(item, fail) {
  const amount = billingDocumentAmount(item.lineItems, fail);
  if (!plain(item.summary) || Object.keys(item.summary).join(',') !== 'amountCents' || item.summary.amountCents !== amount)
    fail(409, 'BILLING_DATA_INVALID', '已開立帳單金額無法確認，請重新核對保存資料');
  return amount;
}
function activeReceiptAmount(items, documentId, fail) {
  let total = 0n;
  for (const item of items.filter(row => row.billingDocumentId === documentId)) {
    if (!['active', 'cancelled'].includes(item.status)) fail(409, 'BILLING_DATA_INVALID', '帳單的收款狀態無法確認');
    if (item.status !== 'active') continue;
    if (!Number.isSafeInteger(item.amountCents) || item.amountCents < 1 || item.amountCents > 1000000000)
      fail(409, 'BILLING_DATA_INVALID', '帳單的保存收款金額無法確認');
    total += BigInt(item.amountCents);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'BILLING_DATA_INVALID', '帳單的收款累計超出可精確範圍');
  }
  return Number(total);
}

export function billingDocumentVisible(db, ctx, entity, item, get) {
  if (!isBillingDocumentEntity(entity)) return true;
  if (!item || item.orgId !== ctx.orgId || typeof item.id !== 'string' || !Number.isSafeInteger(item.version) || item.version < 1) return false;
  if (entity === billingDocumentEntity) {
    const parentCase = typeof item.caseId === 'string' && get(db, ctx.orgId, 'cases', item.caseId);
    return !!parentCase && parentCase.orgId === ctx.orgId && plain(item.caseSnapshot)
      && Object.keys(item.caseSnapshot).sort().join(',') === 'caseNo,id,name' && item.caseSnapshot.id === item.caseId
      && typeof item.caseSnapshot.name === 'string' && typeof item.caseSnapshot.caseNo === 'string';
  }
  const parent = typeof item.billingDocumentId === 'string' && get(db, ctx.orgId, billingDocumentEntity, item.billingDocumentId);
  return !!parent && billingDocumentVisible(db, ctx, billingDocumentEntity, parent, get);
}
export function billingDocumentHistoryVisible(db, ctx, entity, snapshot, current, get) {
  if (!billingDocumentVisible(db, ctx, entity, snapshot, get) || snapshot.id !== current.id) return false;
  return entity === paymentReceiptEntity ? snapshot.billingDocumentId === current.billingDocumentId
    : ['caseId', 'month', 'number'].every(key => snapshot[key] === current[key]);
}

export function validateBillingDocument(db, ctx, entity, data, old, fail, dateValid, rows, get) {
  if (!isBillingDocumentEntity(entity)) return;
  guardBillingDocumentAccess(entity, ctx, false, fail);
  if (old && !billingDocumentVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可操作帳單或收款');
  const spec = billingDocumentEntities[entity];
  for (const [key, maximum] of Object.entries(spec.maxLengths)) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum))
    fail(422, 'INVALID_FIELD', '帳單欄位格式或長度不符', { [key]: `請提供最多${maximum}字元的文字` });
  if (!spec.statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '帳單或收款狀態不合法', { status: '請選擇合法狀態' });
  if (entity === billingDocumentEntity) {
    if (typeof data.caseId !== 'string' || !data.caseId.trim()) fail(422, 'REQUIRED', '請指定帳單個案', { caseId: '個案必填' });
    if (typeof data.number !== 'string' || !data.number.trim() || /[\r\n]/.test(data.number)) fail(422, 'REQUIRED', '請填寫單行帳單編號', { number: '帳單編號必填' });
    if (!monthValid(data.month)) fail(422, 'INVALID_MONTH', '帳單月份須為有效YYYY-MM', { month: '月份格式錯誤' });
    const caseItem = get(db, ctx.orgId, 'cases', data.caseId);
    if (!caseItem) fail(422, 'INVALID_REFERENCE', '個案不存在或不屬於本機構', { caseId: '請選擇同機構個案' });
    const amountCents = billingDocumentAmount(data.lineItems, fail);
    if (rows(db, ctx.orgId, entity).some(item => item.id !== old?.id && item.number === data.number))
      fail(409, 'DUPLICATE_NUMBER', '本機構已有相同帳單編號', { number: '請使用未使用的編號' });
    if (!old && data.status !== 'draft') fail(422, 'BILLING_STATE', '新帳單須先建立草稿', { status: '請先建立草稿' });
    if (old && ['caseId', 'month', 'number'].some(key => data[key] !== old[key])) fail(409, 'BILLING_IDENTITY_IMMUTABLE', '建立後不可更換個案、月份或帳單編號');
    if (old?.status === 'voided') fail(409, 'BILLING_LOCKED', '已作廢帳單不可改寫，請建立新草稿');
    if (old?.status === 'issued') {
      if (data.status !== 'voided' || spec.fields.split(' ').filter(key => !['status', 'note'].includes(key)).some(key => !same(data[key], old[key])))
        fail(409, 'BILLING_LOCKED', '已開立帳單內容已鎖定，只可填寫原因後作廢');
      issuedAmount(old, fail);
      if (!data.note?.trim()) fail(422, 'REASON_REQUIRED', '作廢須填寫原因', { note: '作廢原因必填' });
      if (rows(db, ctx.orgId, paymentReceiptEntity).some(item => item.billingDocumentId === old.id && item.status !== 'cancelled'))
        fail(409, 'ACTIVE_RECEIPTS', '帳單仍有未取消收款，請先核對並取消相關收款紀錄');
      data.summary = structuredClone(old.summary); data.caseSnapshot = structuredClone(old.caseSnapshot);
      return;
    }
    if (data.status === 'voided') fail(409, 'BILLING_STATE', '草稿不可直接作廢，請保留草稿或完成開立');
    if (old && old.status !== 'draft') fail(409, 'BILLING_DATA_INVALID', '帳單原狀態無法確認');
    if (data.status === 'issued' && !data.sourceReference?.trim()) fail(422, 'SOURCE_REQUIRED', '開立前須填寫人工計價依據', { sourceReference: '計價依據必填' });
    if (typeof caseItem.name !== 'string' || typeof caseItem.caseNo !== 'string') fail(409, 'BILLING_DATA_INVALID', '個案識別資料無法確認');
    data.summary = { amountCents }; data.caseSnapshot = { id: caseItem.id, name: caseItem.name, caseNo: caseItem.caseNo };
    return;
  }
  if (typeof data.billingDocumentId !== 'string' || !data.billingDocumentId.trim()) fail(422, 'REQUIRED', '請指定帳單', { billingDocumentId: '帳單必填' });
  const parent = get(db, ctx.orgId, billingDocumentEntity, data.billingDocumentId);
  if (!parent || !billingDocumentVisible(db, ctx, billingDocumentEntity, parent, get)) fail(422, 'INVALID_REFERENCE', '帳單不存在或不屬於本機構', { billingDocumentId: '請選擇同機構帳單' });
  if (!dateValid(data.date) || data.date.slice(0, 4) === '0000') fail(422, 'INVALID_DATE', '收款日須為有效YYYY-MM-DD', { date: '日期格式錯誤' });
  if (!Number.isSafeInteger(data.amountCents) || data.amountCents < 1 || data.amountCents > 1000000000)
    fail(422, 'INVALID_AMOUNT', '收款須為1至1000000000的整數分', { amountCents: '金額格式或範圍不符' });
  if (!['cash', 'transfer', 'other'].includes(data.method)) fail(422, 'INVALID_METHOD', '請選擇現金、轉帳或其他', { method: '收款方式不合法' });
  if (old) {
    if (old.status !== 'active') fail(409, 'RECEIPT_LOCKED', '已取消收款不可改寫');
    if (data.status !== 'cancelled' || spec.fields.split(' ').filter(key => !['status', 'note'].includes(key)).some(key => !same(data[key], old[key])))
      fail(409, 'RECEIPT_LOCKED', '收款內容與父帳單已鎖定，只可填寫原因後取消');
    if (!data.note?.trim()) fail(422, 'REASON_REQUIRED', '取消收款須填寫原因', { note: '取消原因必填' });
    return;
  }
  if (data.status !== 'active') fail(422, 'RECEIPT_STATE', '新收款須建立有效紀錄', { status: '新增只允許有效收款' });
  if (parent.status !== 'issued') fail(409, 'BILLING_NOT_ISSUED', '只有已開立帳單可登錄收款');
  const total = issuedAmount(parent, fail), collected = activeReceiptAmount(rows(db, ctx.orgId, paymentReceiptEntity), parent.id, fail);
  if (BigInt(collected) + BigInt(data.amountCents) > BigInt(total)) fail(409, 'OVERPAYMENT', '本次收款超過帳單未收餘額', { amountCents: '請重新核對目前未收餘額' });
}

export function billingDocumentQuery(entity, params, fail, mode = 'list') {
  if (!isBillingDocumentEntity(entity)) return {};
  const allowed = mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', 'month', 'caseId', ...(entity === paymentReceiptEntity ? ['billingDocumentId'] : [])];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '帳單查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  const integer = (key, fallback, maximum) => {
    const text = params.has(key) ? params.get(key) : String(fallback), value = Number(text);
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value) || value > maximum) fail(422, 'PAGINATION', '分頁參數不合法', { [key]: '請提供範圍內正整數' });
    return value;
  };
  const page = integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize = integer('pageSize', 25, 100);
  const q = params.get('q') || '', status = params.get('status') || '', month = params.get('month') || '', caseId = params.get('caseId') || '', billingDocumentId = params.get('billingDocumentId') || '';
  if (q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (params.has('status') && !billingDocumentEntities[entity].statuses.includes(status)) fail(422, 'INVALID_STATUS', '查詢狀態不合法');
  if (params.has('month') && !monthValid(month)) fail(422, 'INVALID_MONTH', '查詢月份須為有效YYYY-MM');
  for (const key of ['caseId', 'billingDocumentId']) if (params.has(key) && (!params.get(key) || params.get(key).length > 100)) fail(422, 'INVALID_REFERENCE', '查詢關聯識別碼不合法');
  const compare = params.has('compare') ? params.get('compare') : undefined;
  if (compare !== undefined && compare !== 'previous') fail(422, 'INVALID_COMPARE', '只支援compare=previous');
  return { page, pageSize, q, status, month, caseId, billingDocumentId, compare };
}
export function filterBillingDocuments(db, ctx, entity, items, query, fail, get) {
  if (query.caseId && !get(db, ctx.orgId, 'cases', query.caseId)) fail(404, 'NOT_FOUND', '找不到可查詢個案');
  if (query.billingDocumentId && !billingDocumentVisible(db, ctx, billingDocumentEntity, get(db, ctx.orgId, billingDocumentEntity, query.billingDocumentId), get)) fail(404, 'NOT_FOUND', '找不到可查詢帳單');
  const q = query.q.toLowerCase(), textFields = entity === billingDocumentEntity ? ['number', 'sourceReference', 'note'] : ['method', 'reference', 'note'];
  return items.filter(item => {
    const parent = entity === billingDocumentEntity ? item : get(db, ctx.orgId, billingDocumentEntity, item.billingDocumentId);
    return !!parent && (!query.status || item.status === query.status) && (!query.month || parent.month === query.month)
      && (!query.caseId || parent.caseId === query.caseId) && (!query.billingDocumentId || item.billingDocumentId === query.billingDocumentId)
      && (!q || textFields.some(key => typeof item[key] === 'string' && item[key].toLowerCase().includes(q)));
  });
}
