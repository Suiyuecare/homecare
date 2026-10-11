// Pure adapters for ordinary shared form controls. Amounts never pass through floats.
const billFields = ['caseId', 'month', 'number', 'lineItems', 'sourceReference', 'status', 'note'];
const receiptFields = ['billingDocumentId', 'date', 'amountCents', 'method', 'reference', 'status', 'note'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
const text = (values, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(values, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid(key, '請填寫文字欄位。');
  return descriptor.value;
};
const area = value => value.replace(/\r\n?/g, '\n');
const single = value => value.replace(/[\r\n]/g, '');
export const validBillingDate = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

export function parseBillingMoney(value, { key = 'amount', minCents = 0, maxCents = 1000000000 } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) invalid(key, '請填寫最多兩位小數的非負金額（元）。');
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minCents) || !Number.isSafeInteger(maxCents) || amount < BigInt(minCents) || amount > BigInt(maxCents))
    invalid(key, '金額超出可保存範圍。');
  return Number(amount);
}
export function formatBillingCents(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) invalid('amount', '保存金額無法確認。');
  const cents = BigInt(amount);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export function billingLineTotal(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) invalid('lineItems', '明細須為1至100筆。');
  let total = 0n;
  for (const line of lines) {
    if (!plain(line) || Object.keys(line).sort().join(',') !== 'label,quantity,unitPriceCents'
      || typeof line.label !== 'string' || !line.label.trim() || line.label.length > 300 || /[\r\n]/.test(line.label)
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000
      || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0 || line.unitPriceCents > 1000000000)
      invalid('lineItems', '保存明細格式無法確認。');
    total += BigInt(line.quantity) * BigInt(line.unitPriceCents);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid('lineItems', '總額超出可精確保存範圍。');
  }
  return Number(total);
}

/** Build a minimal PATCH by comparing native display values before normalizing. */
export function createBillingDocumentEditor({ existing, lineCount = 1, cases = [], month = '' } = {}) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 100 || !Array.isArray(cases)) invalid('lineCount', '明細筆數須為1至100。');
  if (existing) { checkBillingRecord({ item: existing }, { entity: 'billing-documents', orgId: existing.orgId }); if (existing.status !== 'draft') invalid('status', '僅可編輯草稿。'); }
  const source = existing || { caseId: '', month, number: '', sourceReference: '', note: '' };
  const initial = { caseId: source.caseId, month: source.month, number: source.number, sourceReference: source.sourceReference, note: source.note };
  const baseline = { ...initial, sourceReference: area(initial.sourceReference), note: area(initial.note) };
  const fields = [
    existing ? { name: 'caseId', label: '個案', type: 'select', disabled: true,
      options: [{ value: existing.caseId, label: `${existing.caseSnapshot.name} · ${existing.caseSnapshot.caseNo}` }], help: '建立後個案不可更換。' }
      : { name: 'caseId', label: '個案', type: 'select', required: true, options: cases.map(item => ({ value: item.id, label: `${item.name} · ${item.caseNo}` })) },
    { name: 'month', label: '帳單月份', type: 'month', required: true, readOnly: !!existing },
    { name: 'number', label: '帳單編號', required: true, maxLength: 100, readOnly: !!existing },
  ];
  for (let index = 0; index < lineCount; index++) {
    const line = existing?.lineItems[index] || { label: '', quantity: 1, unitPriceCents: 0 };
    const label = `lineLabel${index}`, quantity = `lineQuantity${index}`, price = `linePrice${index}`;
    initial[label] = line.label; initial[quantity] = String(line.quantity); initial[price] = formatBillingCents(line.unitPriceCents);
    baseline[label] = single(line.label); baseline[quantity] = initial[quantity]; baseline[price] = initial[price];
    fields.push({ name: label, label: `明細${index + 1} 名稱`, required: true, maxLength: 300, wide: true },
      { name: quantity, label: `明細${index + 1} 數量`, required: true, inputMode: 'numeric', maxLength: 5, help: '1至10000的整數。' },
      { name: price, label: `明細${index + 1} 單價（元）`, required: true, inputMode: 'decimal', maxLength: 15, help: '最多兩位小數；人工填寫計價依據。' });
  }
  fields.push({ name: 'sourceReference', label: '人工計價依據', type: 'textarea', maxLength: 2000, help: '開立前必填；請記錄經人工核定的依據。' },
    { name: 'note', label: '備註', type: 'textarea', maxLength: 10000 });
  const names = new Set(fields.map(field => field.name));
  return { fields, initial, initialDisplay: Object.freeze({ ...baseline }), buildPayload(values) {
    if (!plain(values) || Reflect.ownKeys(values).some(key => typeof key !== 'string' || !names.has(key))) invalid('number', '表單包含未知欄位。');
    const payload = {};
    for (const key of ['caseId', 'month', 'number']) {
      const value = text(values, key);
      if (existing && value !== baseline[key]) invalid(key, '建立後個案、月份與編號不可變更。');
      if (!existing) payload[key] = value.trim();
    }
    if (!existing && !cases.some(item => item.id === payload.caseId)) invalid('caseId', '請選擇已確認的同機構個案。');
    if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(existing?.month || payload.month)) invalid('month', '請填寫有效月份。');
    if (!existing && (!payload.number || /[\r\n]/.test(payload.number))) invalid('number', '請填寫單行帳單編號。');
    for (const key of ['sourceReference', 'note']) {
      const value = text(values, key);
      if (existing && value === baseline[key]) continue;
      const normalized = key === 'note' ? value : value.trim();
      if (!existing || normalized !== source[key]) payload[key] = normalized;
    }
    const lines = [];
    let changed = !existing || existing.lineItems.length !== lineCount;
    for (let index = 0; index < lineCount; index++) {
      const keys = [`lineLabel${index}`, `lineQuantity${index}`, `linePrice${index}`], raw = keys.map(key => text(values, key));
      const original = existing?.lineItems[index];
      if (original && raw.every((value, position) => value === baseline[keys[position]])) { lines.push(structuredClone(original)); continue; }
      const label = original && raw[0] === baseline[keys[0]] ? original.label : raw[0].trim();
      if (!label || label.length > 300 || /[\r\n]/.test(label)) invalid(keys[0], '請填寫最多300字元的單行明細名稱。');
      const quantityText = raw[1].trim();
      if (!/^[1-9]\d*$/.test(quantityText) || Number(quantityText) > 10000) invalid(keys[1], '數量須為1至10000的整數。');
      const line = { label, quantity: Number(quantityText), unitPriceCents: parseBillingMoney(raw[2], { key: keys[2] }) };
      lines.push(line); if (!same(line, original)) changed = true;
    }
    billingLineTotal(lines);
    if (changed) payload.lineItems = lines;
    if (!existing) payload.status = 'draft';
    return payload;
  } };
}

export function createPaymentReceiptPayload(values, billingDocumentId) {
  if (!plain(values) || Object.keys(values).sort().join(',') !== 'amount,date,method,note,reference') invalid('amount', '收款表單包含未知欄位。');
  const date = text(values, 'date').trim(), method = text(values, 'method');
  if (!validBillingDate(date)) invalid('date', '請填寫有效收款日期。');
  if (!['cash', 'transfer', 'other'].includes(method)) invalid('method', '請選擇收款方式。');
  if (typeof billingDocumentId !== 'string' || !billingDocumentId) invalid('amount', '父帳單無法確認。');
  return { billingDocumentId, date, amountCents: parseBillingMoney(text(values, 'amount'), { key: 'amount', minCents: 1 }), method,
    reference: text(values, 'reference').trim(), note: text(values, 'note'), status: 'active' };
}

export function checkBillingRecord(result, { entity, id, orgId, original, payload } = {}) {
  const item = result?.item, invoice = entity === 'billing-documents', keys = invoice ? billFields : receiptFields;
  if (!['billing-documents', 'payment-receipts'].includes(entity) || !plain(item) || typeof item.id !== 'string' || !item.id
    || (id && item.id !== id) || item.orgId !== orgId || !Number.isSafeInteger(item.version) || item.version < 1
    || keys.filter(key => !['lineItems', 'amountCents'].includes(key)).some(key => typeof item[key] !== 'string'))
    invalid('number', '無法確認保存資料，請重新讀取。');
  if (invoice) {
    if (!['draft', 'issued', 'voided'].includes(item.status) || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(item.month)
      || !item.caseId || !item.number || !plain(item.caseSnapshot) || item.caseSnapshot.id !== item.caseId
      || typeof item.caseSnapshot.name !== 'string' || typeof item.caseSnapshot.caseNo !== 'string'
      || !plain(item.summary) || Object.keys(item.summary).join(',') !== 'amountCents' || item.summary.amountCents !== billingLineTotal(item.lineItems))
      invalid('number', '保存帳單總額或個案識別無法確認。');
  } else if (!['active', 'cancelled'].includes(item.status) || !item.billingDocumentId || !validBillingDate(item.date)
    || !Number.isSafeInteger(item.amountCents) || item.amountCents < 1 || item.amountCents > 1000000000 || !['cash', 'transfer', 'other'].includes(item.method))
    invalid('amount', '保存收款資料無法確認。');
  if (payload) {
    if (item.version !== (original ? original.version + 1 : 1)
      || Object.entries(payload).some(([key, value]) => key !== 'version' && !same(item[key], value))
      || (original && keys.some(key => !same(item[key], Object.hasOwn(payload, key) ? payload[key] : original[key]))))
      invalid(invoice ? 'number' : 'amount', '無法確認儲存結果；請保留輸入並重新讀取。');
    if (original && original.status === 'issued' && !same(item.caseSnapshot, original.caseSnapshot)) invalid('number', '已開立個案快照不得改寫。');
  }
  return item;
}
