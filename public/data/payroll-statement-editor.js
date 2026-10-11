import { createServiceItemEditor } from './service-item-editor.js';

export const PAYROLL_STATEMENT_STATUSES = Object.freeze([{ value: 'draft', label: '草稿' }, { value: 'reviewed', label: '已覆核' }, { value: 'closed', label: '已關帳' }, { value: 'voided', label: '已取消' }]);
export const PAYROLL_LINE_KINDS = Object.freeze([{ value: 'earning', label: '加項' }, { value: 'deduction', label: '減項' }]);
const names = ['employeeId', 'month', 'number', 'lineItems', 'sourceReference', 'status', 'note'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => Object.hasOwn(object, key);
const invalid = (field, message) => { const error = new Error(message); error.fields = { [field]: message }; throw error; };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validMonth = value => typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
// The established service-item adapter owns exact decimal-to-cents parsing.
const exactMoney = createServiceItemEditor();
export function parsePayrollAmount(value, field = 'amount') {
  try { return exactMoney.buildPayload({ ...exactMoney.initial, code: 'MANUAL-PAYROLL', name: '人工薪資金額', unitPrice: value }).unitPriceCents; }
  catch { invalid(field, '請輸入非負金額，最多兩位小數，不含空白、符號或指數；上限10000000.00元。'); }
}
export function payrollAmountText(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) invalid('lineItems', '無法確認保存金額。');
  const exact = BigInt(cents); return `${exact / 100n}.${String(exact % 100n).padStart(2, '0')}`;
}
export function payrollSummary(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) invalid('rowCount', '請提供1至100筆薪資明細。');
  let earning = 0n, deduction = 0n;
  for (const item of items) {
    if (!plain(item) || Object.keys(item).length !== 3 || Object.keys(item).some(key => !['label', 'kind', 'amountCents'].includes(key))
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100 || !PAYROLL_LINE_KINDS.some(kind => kind.value === item.kind)
      || !Number.isSafeInteger(item.amountCents) || item.amountCents < 0 || item.amountCents > 1e9) invalid('rowCount', '保存明細無法確認。');
    if (item.kind === 'earning') earning += BigInt(item.amountCents); else deduction += BigInt(item.amountCents);
  }
  if (deduction > earning) invalid('rowCount', '減項合計不可超過加項合計。');
  if (earning > BigInt(Number.MAX_SAFE_INTEGER) || deduction > BigInt(Number.MAX_SAFE_INTEGER)) invalid('rowCount', '明細合計超出安全範圍。');
  return { earningCents: Number(earning), deductionCents: Number(deduction), netCents: Number(earning - deduction) };
}
export function assertPayrollStatement(item, { orgId, id, version } = {}) {
  if (!plain(item) || typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || item.orgId !== orgId
    || id !== undefined && item.id !== id || !Number.isSafeInteger(item.version) || item.version < 1 || version !== undefined && item.version !== version)
    invalid('note', '無法確認薪資結算的機構、識別或版次。');
  for (const key of names) if (!own(item, key)) invalid('note', '薪資結算保存欄位不完整。');
  if (typeof item.employeeId !== 'string' || !item.employeeId.trim() || !validMonth(item.month) || typeof item.number !== 'string' || !item.number.trim() || item.number.length > 100
    || typeof item.sourceReference !== 'string' || item.sourceReference.length > 500 || typeof item.note !== 'string' || item.note.length > 10000 || !PAYROLL_STATEMENT_STATUSES.some(status => status.value === item.status))
    invalid('note', '薪資結算保存資料格式不符。');
  const snapshot = item.employeeSnapshot;
  if (!plain(snapshot) || Object.keys(snapshot).length !== 3 || snapshot.id !== item.employeeId || typeof snapshot.name !== 'string' || typeof snapshot.employeeNo !== 'string')
    invalid('note', '無法確認薪資員工快照。');
  const summary = payrollSummary(item.lineItems);
  if (!plain(item.summary) || Object.keys(item.summary).length !== 3 || Object.keys(summary).some(key => item.summary[key] !== summary[key])) invalid('note', '薪資合計與保存明細不一致。');
  return item;
}
export function confirmPayrollStatementList(response, request) {
  if (!plain(response) || !Array.isArray(response.items) || response.page !== request.page || response.pageSize !== 25 || !Number.isSafeInteger(response.total) || response.total < 0
    || response.items.length !== Math.max(0, Math.min(25, response.total - (request.page - 1) * 25))) invalid('note', '薪資清單回應未確認。');
  const ids = new Set();
  for (const item of response.items) {
    assertPayrollStatement(item, request);
    if (ids.has(item.id) || request.status && item.status !== request.status || request.month && item.month !== request.month || request.employeeId && item.employeeId !== request.employeeId)
      invalid('note', '薪資清單範圍未確認。');
    ids.add(item.id);
  }
  return response;
}
export function createPayrollStatementEditor({ existing = null, orgId, employees = [] } = {}) {
  const editing = existing !== null, original = editing ? structuredClone(assertPayrollStatement(existing, { orgId })) : null;
  if (editing && original.status !== 'draft') invalid('note', '只有草稿可以編輯薪資內容。');
  const initial = { employeeId: original?.employeeId || '', month: original?.month || '', number: original?.number || '', sourceReference: original?.sourceReference || '', note: original?.note || '', rowCount: original?.lineItems.length || 1, confirmRemove: false };
  const fields = [
    { name: 'employeeId', label: '員工', type: 'select', required: !editing, disabled: editing, options: employees.map(employee => ({ value: employee.id, label: `${employee.employeeNo} ${employee.name}${employee.status === 'inactive' ? '（已停用）' : ''}` })) },
    { name: 'month', label: '薪資月份', type: 'month', required: !editing, disabled: editing },
    { name: 'number', label: '結算編號', type: 'text', required: !editing, disabled: editing, maxLength: 100 },
  ];
  const intents = new Set();
  for (const key of ['sourceReference', 'note']) {
    const compatible = typeof initial[key] === 'string' && !(key === 'note' ? /\r/.test(initial[key]) : /[\r\n]/.test(initial[key]));
    if (!compatible) {
      intents.add(key); initial[key + 'Intent'] = 'keep'; initial[key] = '';
      fields.push({ name: key + 'Intent', label: (key === 'note' ? '備註' : '核定依據') + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, { value: 'clear', label: '明確清空' }], help: '原文無法無損放入此控制項，保持時不覆寫。' });
    }
    fields.push({ name: key, label: key === 'note' ? '備註' : '人工核定依據', type: key === 'note' ? 'textarea' : 'text', disabled: !compatible, maxLength: key === 'note' ? 10000 : 500 });
  }
  const preserveLines = Boolean(original?.lineItems.some(item => /[\r\n]/.test(item.label)));
  if (preserveLines) {
    initial.lineItemsIntent = 'keep';
    fields.push({ name: 'lineItemsIntent', label: '保存明細處理方式', type: 'select', required: true,
      options: [{ value: 'keep', label: '完整保持原明細' }, { value: 'replace', label: '以本次明細取代' }], help: '原名稱包含無法无損放入單行欄位的內容，保持時原明細不覆寫。' });
  }
  fields.push({ name: 'rowCount', label: '明細筆數', type: 'number', min: 1, max: 100, step: 1, required: true, help: '調整為1至100筆；每筆金額以元輸入，保留精確到分。' },
    { name: 'confirmRemove', label: '確認移除超出明細筆數的已填項目', type: 'checkbox', help: '縮減會移除後面的已填明細；原輸入在本次表單中保留，重新增加筆數可找回。' });
  for (let index = 0; index < 100; index++) {
    const line = original?.lineItems[index], suffix = String(index + 1);
    initial['label' + suffix] = line && !preserveLines ? line.label : '';
    initial['kind' + suffix] = line?.kind || 'earning'; initial['amount' + suffix] = line ? payrollAmountText(line.amountCents) : '0.00';
    fields.push({ name: 'label' + suffix, label: `明細${suffix} 名稱`, type: 'text', maxLength: 100 },
      { name: 'kind' + suffix, label: `明細${suffix} 加項／減項`, type: 'select', options: PAYROLL_LINE_KINDS.map(kind => ({ ...kind })) },
      { name: 'amount' + suffix, label: `明細${suffix} 金額（新臺幣元）`, type: 'text', inputMode: 'decimal', maxLength: 16 });
  }
  const enabled = (key, values = initial) => ['employeeId', 'month', 'number'].includes(key) ? !editing
    : intents.has(key) ? values[key + 'Intent'] === 'replace' : /^(label|kind|amount)\d+$/.test(key) || key === 'rowCount' || key === 'confirmRemove' ? !preserveLines || values.lineItemsIntent === 'replace' : true;
  function buildPayload(values) {
    if (!plain(values) || Object.keys(values).some(key => !own(initial, key))) invalid('note', '表單包含未知欄位。');
    const current = { ...initial, ...values }, payload = {};
    for (const key of ['employeeId', 'month', 'number']) {
      if (editing) { if (current[key] !== initial[key]) invalid(key, '建立後不可更換此欄。'); }
      else {
        if (typeof current[key] !== 'string' || !current[key].trim() || key === 'month' && !validMonth(current[key]) || key === 'number' && current[key].trim().length > 100) invalid(key, '請填寫有效的必要內容。');
        payload[key] = current[key].trim();
      }
    }
    for (const key of ['sourceReference', 'note']) {
      let value = current[key];
      if (intents.has(key)) {
        if (current[key + 'Intent'] === 'keep') continue;
        if (current[key + 'Intent'] === 'clear') value = '';
        else if (current[key + 'Intent'] !== 'replace') invalid(key + 'Intent', '請選擇有效處理方式。');
      } else if (editing && value === initial[key]) continue;
      if (typeof value !== 'string' || value.length > (key === 'note' ? 10000 : 500)) invalid(key, '文字長度或格式不符。');
      payload[key] = key === 'note' ? value : value.trim();
    }
    if (preserveLines && current.lineItemsIntent === 'keep') return payload;
    if (preserveLines && current.lineItemsIntent !== 'replace') invalid('lineItemsIntent', '請選擇有效處理方式。');
    const count = current.rowCount;
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) invalid('rowCount', '明細筆數須為1至100的整數。');
    const hidden = Array.from({ length: 100 - count }, (_, index) => index + count + 1).some(index => original?.lineItems[index - 1]
      || String(current['label' + index] || '').trim() || current['amount' + index] !== '0.00' && current['amount' + index] !== '');
    if (hidden && current.confirmRemove !== true) invalid('confirmRemove', '請明確勾選確認移除縮減筆數後的已填明細。');
    const items = [];
    for (let index = 1; index <= count; index++) {
      const label = current['label' + index], kind = current['kind' + index];
      if (typeof label !== 'string' || !label.trim() || label.trim().length > 100 || /[\r\n]/.test(label)) invalid('label' + index, '請填寫單行明細名稱，最多100字。');
      if (!PAYROLL_LINE_KINDS.some(choice => choice.value === kind)) invalid('kind' + index, '請選擇加項或減項。');
      const amountCents = parsePayrollAmount(current['amount' + index], 'amount' + index);
      items.push({ label: editing && label === initial['label' + index] && original.lineItems[index - 1] ? original.lineItems[index - 1].label : label.trim(), kind, amountCents });
    }
    payrollSummary(items);
    if (!editing || !same(items, original.lineItems)) payload.lineItems = items;
    return payload;
  }
  function confirm(item, payload) {
    assertPayrollStatement(item, { orgId, ...(editing ? { id: original.id, version: original.version + 1 } : { version: 1 }) });
    const expected = { ...(editing ? original : { sourceReference: '', note: '', status: 'draft' }), ...payload };
    for (const key of names) if (own(item, key) !== own(expected, key) || !same(item[key], expected[key])) invalid('note', '儲存結果未確認，請保留輸入並重新讀取。');
    if (editing && !same(item.employeeSnapshot, original.employeeSnapshot)) invalid('note', '保存員工快照未確認。');
    return item;
  }
  return { initial, fields, enabled, buildPayload, confirm };
}
export function confirmPayrollTransition(item, original, payload, orgId) {
  assertPayrollStatement(item, { orgId, id: original.id, version: original.version + 1 });
  for (const key of [...names, 'summary', 'employeeSnapshot']) if (!same(item[key], own(payload, key) ? payload[key] : original[key])) invalid('note', '狀態變更保存結果未確認，請重新讀取。');
  return item;
}
